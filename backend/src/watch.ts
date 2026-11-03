import crypto from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';
import { logger } from './log.js';
import { parseTarget, readTls, safeFetch } from './net.js';
import { scanUrl } from './scanner.js';

const MAX_WATCHES_PER_WORKSPACE = 20;
const MAX_EVENTS_PER_WATCH = 200;
const FAILURES_BEFORE_DOWN = 2;

export class WatchError extends Error {}

interface WatchRow {
  id: string;
  url: string;
  label: string;
  notify_url: string | null;
  created_at: string;
  status: string;
  status_code: number | null;
  response_ms: number | null;
  checks_total: number;
  checks_ok: number;
  tls_days: number | null;
  grade: string | null;
  score: number | null;
  last_check_at: string | null;
  last_scan_at: string | null;
}

export const hashWorkspace = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

function logEvent(watchId: string, kind: string, message: string) {
  db.prepare('INSERT INTO events (watch_id, at, kind, message) VALUES (?, ?, ?, ?)').run(watchId, new Date().toISOString(), kind, message);
  db.prepare('DELETE FROM events WHERE watch_id = ? AND id NOT IN (SELECT id FROM events WHERE watch_id = ? ORDER BY id DESC LIMIT ?)').run(watchId, watchId, MAX_EVENTS_PER_WATCH);
}

function present(row: WatchRow) {
  const events = db.prepare('SELECT at, kind, message FROM events WHERE watch_id = ? ORDER BY id DESC LIMIT 8').all(row.id);
  return {
    id: row.id,
    url: row.url,
    label: row.label,
    hasNotify: Boolean(row.notify_url),
    createdAt: row.created_at,
    status: row.status,
    statusCode: row.status_code,
    responseMs: row.response_ms,
    uptime: row.checks_total ? Math.round((row.checks_ok / row.checks_total) * 1000) / 10 : null,
    tlsDays: row.tls_days,
    grade: row.grade,
    score: row.score,
    lastCheckAt: row.last_check_at,
    lastScanAt: row.last_scan_at,
    events,
  };
}

export function listWatches(workspace: string) {
  const rows = db.prepare('SELECT * FROM watches WHERE workspace = ? ORDER BY created_at').all(hashWorkspace(workspace)) as unknown as WatchRow[];
  return rows.map(present);
}

export async function addWatch(workspace: string, input: { url: string; label?: string; notifyUrl?: string }) {
  const hash = hashWorkspace(workspace);
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM watches WHERE workspace = ?').get(hash) as { count: number };
  if (count >= MAX_WATCHES_PER_WORKSPACE) throw new WatchError(`You can watch up to ${MAX_WATCHES_PER_WORKSPACE} apps for now.`);
  const url = parseTarget(input.url);
  if (input.notifyUrl) parseTarget(input.notifyUrl);
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO watches (id, workspace, url, label, notify_url, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, hash, url.href, input.label?.trim() || url.hostname, input.notifyUrl ?? null, new Date().toISOString(),
  );
  logEvent(id, 'added', 'Started watching this app');
  const row = db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as unknown as WatchRow;
  await checkWatch(row, true);
  return present(db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as unknown as WatchRow);
}

export function removeWatch(workspace: string, id: string) {
  const result = db.prepare('DELETE FROM watches WHERE id = ? AND workspace = ?').run(id, hashWorkspace(workspace));
  if (result.changes) db.prepare('DELETE FROM events WHERE watch_id = ?').run(id);
  return result.changes > 0;
}

async function notify(row: WatchRow, text: string) {
  if (!row.notify_url) return;
  // Slack uses "text", Discord uses "content", ntfy shows the raw body. One JSON shape covers the first two.
  await safeFetch(row.notify_url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, content: text }),
    redirects: 0,
    maxBytes: 10_000,
  }).catch((err: unknown) => logger.warn({ err, watch: row.id }, 'notify failed'));
}

const recentFailures = new Map<string, number>();

export async function checkWatch(row: WatchRow, forceScan = false) {
  const started = Date.now();
  const now = new Date().toISOString();
  const res = await safeFetch(row.url, { maxBytes: 200_000, timeoutMs: 15_000 }).catch(() => null);
  const ok = res !== null && res.status < 500;
  const ms = res ? Date.now() - started : null;

  const failures = ok ? 0 : (recentFailures.get(row.id) ?? 0) + 1;
  recentFailures.set(row.id, failures);
  const status = ok ? 'up' : failures >= FAILURES_BEFORE_DOWN || row.status === 'pending' ? 'down' : row.status;

  if (status !== row.status && row.status !== 'pending') {
    const message = status === 'down' ? `${row.label} is down${res ? ` (HTTP ${res.status})` : ''}` : `${row.label} is back up`;
    logEvent(row.id, status, message);
    await notify(row, message);
  } else if (row.status === 'pending') {
    logEvent(row.id, status, status === 'up' ? 'First check passed' : 'First check failed');
  }

  let tlsDays = row.tls_days;
  const target = new URL(row.url);
  if (ok && target.protocol === 'https:') {
    const tls = await readTls(target.hostname).catch(() => null);
    tlsDays = tls?.daysLeft ?? tlsDays;
    if (tlsDays !== null && tlsDays <= 14 && row.tls_days !== null && row.tls_days > 14) {
      const message = `The HTTPS certificate for ${row.label} expires in ${tlsDays} days`;
      logEvent(row.id, 'tls', message);
      await notify(row, message);
    }
  }

  db.prepare('UPDATE watches SET status = ?, status_code = ?, response_ms = ?, checks_total = checks_total + 1, checks_ok = checks_ok + ?, tls_days = ?, last_check_at = ? WHERE id = ?').run(
    status, res?.status ?? null, ms, ok ? 1 : 0, tlsDays, now, row.id,
  );

  const scanDue = !row.last_scan_at || Date.now() - Date.parse(row.last_scan_at) >= config.rescanIntervalMs;
  if (ok && (forceScan || scanDue)) {
    try {
      const report = await scanUrl(row.url);
      db.prepare('UPDATE watches SET grade = ?, score = ?, last_scan_at = ? WHERE id = ?').run(report.grade, report.score, now, row.id);
      if (row.grade && row.grade !== report.grade) {
        const message = `Security grade for ${row.label} went from ${row.grade} to ${report.grade}`;
        logEvent(row.id, 'grade', message);
        await notify(row, message);
      } else if (!row.grade) {
        logEvent(row.id, 'grade', `First security grade: ${report.grade}`);
      }
    } catch (err) {
      logger.warn({ err, watch: row.id }, 'rescan failed');
    }
  }
}

let running = false;

export async function runDueChecks() {
  if (running) return;
  running = true;
  try {
    const cutoff = new Date(Date.now() - config.watchIntervalMs).toISOString();
    const due = db.prepare('SELECT * FROM watches WHERE last_check_at IS NULL OR last_check_at <= ? ORDER BY last_check_at LIMIT 100').all(cutoff) as unknown as WatchRow[];
    for (let i = 0; i < due.length; i += 5) {
      await Promise.all(due.slice(i, i + 5).map((row) => checkWatch(row).catch((err: unknown) => logger.error({ err, watch: row.id }, 'check failed'))));
    }
  } finally {
    running = false;
  }
}

export function startWatcher() {
  const timer = setInterval(() => void runDueChecks(), Math.min(60_000, config.watchIntervalMs));
  timer.unref();
  return timer;
}
