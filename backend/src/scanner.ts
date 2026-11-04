import crypto from 'node:crypto';
import { config } from './config.js';
import { headerValue, parseTarget, readTls, safeFetch, type FetchResult, type TlsInfo } from './net.js';
import { findSecrets, findSupabase } from './secrets.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  why: string;
  fix: string;
  evidence?: string;
}

export interface ScanReport {
  url: string;
  finalUrl: string;
  scannedAt: string;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  score: number;
  platform: { host?: string; framework?: string; backend?: string };
  tls: TlsInfo | null;
  findings: Finding[];
  passed: string[];
  stats: { scripts: number; bytes: number; thirdPartyScripts: number };
  owner: { verified: boolean; token: string; checksRun: string[] };
  fixPrompt: string;
}

const PENALTY: Record<Severity, number> = { critical: 45, high: 18, medium: 7, low: 2, info: 0 };
const ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

const MAX_SCRIPTS = 40;
const MAX_SCRIPT_BYTES = 3_000_000;
const MAX_TOTAL_BYTES = 30_000_000;
const MAX_RLS_TABLES = 40;

// Proving control of the site unlocks the deeper checks. The token doesn't need to be secret:
// only someone who controls the site can publish it there.
export function verifyToken(hostname: string): string {
  return `runvale-verify-${crypto.createHash('sha256').update(`runvale:${hostname.toLowerCase()}`).digest('hex').slice(0, 32)}`;
}

function gradeFor(score: number, findings: Finding[]): ScanReport['grade'] {
  if (findings.some((f) => f.severity === 'critical')) return 'F';
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 55) return 'C';
  return score >= 35 ? 'D' : 'F';
}

function detectPlatform(page: FetchResult, html: string) {
  const host = new URL(page.url).hostname;
  const h = (name: string) => headerValue(page.headers, name) ?? '';
  const server = h('server').toLowerCase();
  let hosting: string | undefined;
  if (host.endsWith('.lovable.app')) hosting = 'Lovable';
  else if (host.endsWith('.replit.app') || host.endsWith('.repl.co')) hosting = 'Replit';
  else if (host.endsWith('.bolt.host')) hosting = 'Bolt';
  else if (h('x-vercel-id') || server === 'vercel') hosting = 'Vercel';
  else if (h('x-nf-request-id') || server === 'netlify') hosting = 'Netlify';
  else if (h('fly-request-id')) hosting = 'Fly.io';
  else if (h('x-render-origin-server') || h('rndr-id')) hosting = 'Render';
  else if (h('x-railway-request-id') || server === 'railway-edge') hosting = 'Railway';
  else if (host === 'github.com' || host.endsWith('.github.com')) hosting = 'GitHub';
  else if (h('x-github-request-id')) hosting = 'GitHub Pages';
  else if (h('cf-ray')) hosting = 'Cloudflare';

  let framework: string | undefined;
  if (html.includes('__NEXT_DATA__') || html.includes('/_next/')) framework = 'Next.js';
  else if (html.includes('__NUXT__') || html.includes('/_nuxt/')) framework = 'Nuxt';
  else if (/\/assets\/index-[\w-]+\.js/.test(html)) framework = 'Vite';
  else if (html.includes('data-sveltekit')) framework = 'SvelteKit';
  else if (h('x-powered-by').toLowerCase().includes('express')) framework = 'Express';
  return { host: hosting, framework };
}

function scriptSources(html: string, base: URL) {
  const own: string[] = [];
  let thirdParty = 0;
  const seen = new Set<string>();
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+\.m?js(?:\?[^"']*)?)["'][^>]*>/gi)) {
    let url: URL;
    try {
      url = new URL(match[1]!, base);
    } catch {
      continue;
    }
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    if (url.hostname === base.hostname) own.push(url.href);
    else thirdParty++;
  }
  return { own, thirdParty };
}

function chunkReferences(js: string, from: string): string[] {
  const found: string[] = [];
  for (const match of js.matchAll(/["'`]((?:\.{1,2}\/|\/)?[\w@./-]+\.m?js)["'`]/g)) {
    const path = match[1]!;
    if (!/^(?:\.{1,2}\/|\/|assets\/|_next\/)/.test(path)) continue;
    try {
      const url = new URL(path, from);
      if (url.hostname === new URL(from).hostname) found.push(url.href);
    } catch {
      /* not a path after all */
    }
  }
  return found;
}

function checkHeaders(page: FetchResult, add: (f: Finding) => void, pass: (s: string) => void, https: boolean) {
  const h = (name: string) => headerValue(page.headers, name);

  const csp = h('content-security-policy');
  if (!csp) {
    add({
      id: 'no-csp', severity: 'medium', title: 'No Content Security Policy',
      why: 'If someone manages to inject a script into your pages, nothing stops the browser from running it.',
      fix: 'Add a Content-Security-Policy header that only allows scripts from your own site.',
    });
  } else if (/script-src[^;]*'unsafe-inline'/.test(csp) || (!csp.includes('script-src') && /default-src[^;]*'unsafe-inline'/.test(csp))) {
    add({
      id: 'weak-csp', severity: 'low', title: "Content Security Policy allows inline scripts",
      why: 'The policy is there, but injected scripts can still run because unsafe-inline is on.',
      fix: 'Remove unsafe-inline from script-src and use nonces or hashes.', evidence: csp.slice(0, 160),
    });
  } else pass('Content Security Policy is set');

  if (https) {
    const hsts = h('strict-transport-security');
    if (!hsts) {
      add({
        id: 'no-hsts', severity: 'medium', title: 'Browsers are not told to always use HTTPS',
        why: 'On a first visit from public Wi-Fi, someone could quietly downgrade the connection.',
        fix: 'Add the header Strict-Transport-Security: max-age=31536000; includeSubDomains.',
      });
    } else pass('HTTPS is enforced with HSTS');
  }

  const xfo = h('x-frame-options');
  if (!xfo && !csp?.includes('frame-ancestors')) {
    add({
      id: 'no-frame-protection', severity: 'low', title: 'Your site can be embedded in other sites',
      why: 'An attacker can put your pages in an invisible frame and trick people into clicking things (clickjacking).',
      fix: "Add X-Frame-Options: DENY or a CSP rule frame-ancestors 'self'.",
    });
  } else pass('Clickjacking protection is on');

  if (h('x-content-type-options')?.toLowerCase() !== 'nosniff') {
    add({
      id: 'no-nosniff', severity: 'low', title: 'Browsers may guess file types',
      why: 'A file uploaded as an image could be treated as a script.',
      fix: 'Add the header X-Content-Type-Options: nosniff.',
    });
  } else pass('MIME sniffing is off');

  if (!h('referrer-policy')) {
    add({
      id: 'no-referrer-policy', severity: 'low', title: 'No referrer policy',
      why: 'Full page addresses, including anything private in them, can leak to the sites you link to.',
      fix: 'Add the header Referrer-Policy: strict-origin-when-cross-origin.',
    });
  } else pass('Referrer policy is set');

  const powered = h('x-powered-by');
  if (powered) {
    add({
      id: 'version-leak', severity: 'low', title: 'Your server announces what it runs',
      why: 'It tells attackers which known bugs to try first.',
      fix: 'Remove the X-Powered-By header.', evidence: `X-Powered-By: ${powered}`,
    });
  }

  if (h('access-control-allow-origin') === '*' && h('access-control-allow-credentials') === 'true') {
    add({
      id: 'cors-open', severity: 'high', title: 'Any website can call your app as the logged-in user',
      why: 'Open CORS together with credentials lets other sites read your users\' data.',
      fix: 'Allow only your own domains in Access-Control-Allow-Origin.',
    });
  }

  const raw = page.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  // Analytics and consent cookies are read by scripts on purpose, so HttpOnly only matters for login cookies.
  const weak = cookies.filter((c) => {
    const flags = c.toLowerCase();
    const session = /sess|auth|token|jwt|sid\b|login/i.test(c.split('=')[0]!);
    return (https && !flags.includes('secure')) || (session && (!flags.includes('httponly') || !flags.includes('samesite')));
  });
  if (weak.length) {
    add({
      id: 'weak-cookies', severity: 'medium', title: `${weak.length} cookie${weak.length > 1 ? 's are' : ' is'} missing protection flags`,
      why: 'Without Secure, HttpOnly and SameSite, login cookies are easier to steal.',
      fix: 'Set Secure, HttpOnly and SameSite=Lax on every login cookie.',
      evidence: weak.map((c) => c.split('=')[0]).join(', '),
    });
  } else if (cookies.length) pass('Cookies have their protection flags');
}

async function isVerifiedOwner(origin: string, html: string, token: string, allowPrivate: boolean) {
  if (html.includes(token)) return true;
  try {
    const file = await safeFetch(`${origin}/.well-known/runvale-verify.txt`, { maxBytes: 2_000, allowPrivate, redirects: 0 });
    return file.status === 200 && file.body.toString().includes(token);
  } catch {
    return false;
  }
}

async function probeExposedFiles(origin: string, add: (f: Finding) => void, pass: (s: string) => void, allowPrivate: boolean) {
  const probes = [
    { path: '/.env', looksReal: (t: string) => /^[A-Z][A-Z0-9_]*=/m.test(t) && !/<html/i.test(t), title: 'Your .env file is public', why: 'Anyone can download your passwords and API keys.' },
    { path: '/.git/config', looksReal: (t: string) => t.includes('[core]'), title: 'Your .git folder is public', why: 'Anyone can download your whole source code and its history, including old secrets.' },
    { path: '/.DS_Store', looksReal: (t: string) => t.includes('Bud1'), title: 'A .DS_Store file is public', why: 'It lists the names of files on your server, some of which may be private.' },
  ];
  let clean = true;
  for (const probe of probes) {
    const res = await safeFetch(origin + probe.path, { maxBytes: 20_000, allowPrivate, redirects: 0 }).catch(() => null);
    if (res?.status === 200 && probe.looksReal(res.body.toString('latin1'))) {
      clean = false;
      add({ id: `exposed${probe.path}`, severity: probe.path === '/.DS_Store' ? 'medium' : 'critical', title: probe.title, why: probe.why, fix: `Block ${probe.path} at your web server, then treat every secret in it as stolen and replace it.`, evidence: probe.path });
    }
  }
  if (clean) pass('No .env or .git files are exposed');
}

export type SupabaseFetch = (url: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;

// Tests the effect of the access rules, not whether they exist. Reads one row per table and only
// keeps whether a row came back: the row itself never leaves this function.
export async function probeSupabase(base: string, key: string, get: SupabaseFetch) {
  const headers = { apikey: key, authorization: `Bearer ${key}` };
  const root = await get(`${base}/rest/v1/`, headers);
  if (root.status !== 200) return { checked: 0, open: [] as string[] };
  const spec = JSON.parse(root.body) as { paths?: Record<string, unknown>; definitions?: Record<string, unknown> };
  const tables = Object.keys(spec.definitions ?? {}).length
    ? Object.keys(spec.definitions ?? {})
    : Object.keys(spec.paths ?? {}).map((p) => p.replace(/^\//, '')).filter((p) => p && !p.startsWith('rpc/'));
  const open: string[] = [];
  for (const table of tables.slice(0, MAX_RLS_TABLES)) {
    const res = await get(`${base}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`, headers);
    if (res.status !== 200) continue;
    try {
      const rows: unknown = JSON.parse(res.body);
      if (Array.isArray(rows) && rows.length > 0) open.push(table);
    } catch {
      /* not JSON, so not a table answer */
    }
  }
  return { checked: Math.min(tables.length, MAX_RLS_TABLES), open };
}

export async function scanUrl(input: string, opts: { allowPrivate?: boolean } = {}): Promise<ScanReport> {
  const allowPrivate = opts.allowPrivate ?? config.allowPrivateTargets;
  const target = parseTarget(input, allowPrivate);
  // Past this point the scan stops fetching more scripts and reports what it has.
  const deadline = Date.now() + config.scanDeadlineMs;
  const findings: Finding[] = [];
  const passed: string[] = [];
  const add = (f: Finding) => findings.push(f);
  const pass = (s: string) => passed.push(s);

  const page = await safeFetch(target.href, { maxBytes: 4_000_000, allowPrivate });
  const final = new URL(page.url);
  const html = page.body.toString('utf8');
  const https = final.protocol === 'https:';

  let tls: TlsInfo | null = null;
  if (https) {
    tls = await readTls(final.hostname, final.port ? Number(final.port) : 443, allowPrivate);
    if (tls && !tls.valid) {
      add({ id: 'tls-invalid', severity: 'high', title: "Your HTTPS certificate isn't trusted", why: 'Visitors get a scary browser warning, and the connection can\'t be fully trusted.', fix: 'Use an automatic certificate (Let\'s Encrypt) and make sure it matches your domain.', evidence: tls.error });
    } else if (tls?.daysLeft !== undefined && tls.daysLeft < 14) {
      add({ id: 'tls-expiring', severity: 'high', title: `Your certificate expires in ${tls.daysLeft} days`, why: 'When it runs out, browsers block your site.', fix: 'Check that automatic renewal is working.' });
    } else if (tls) pass(`HTTPS certificate is valid (${tls.daysLeft} days left)`);
    if (tls?.protocol && ['TLSv1', 'TLSv1.1'].includes(tls.protocol)) {
      add({ id: 'tls-old', severity: 'medium', title: `Old encryption version (${tls.protocol})`, why: 'These versions have known weaknesses.', fix: 'Turn on TLS 1.2 or newer only.' });
    }
    const plain = new URL(final.href);
    plain.protocol = 'http:';
    plain.port = '';
    if (!allowPrivate) {
      const http = await safeFetch(plain.href, { allowPrivate, redirects: 0, maxBytes: 2_000, timeoutMs: 6_000 }).catch(() => null);
      if (http && (http.status < 300 || http.status >= 400)) {
        add({ id: 'no-https-redirect', severity: 'medium', title: "The http:// version doesn't send people to https://", why: 'People who type your address may browse unencrypted.', fix: 'Redirect all http traffic to https.' });
      } else if (http) pass('http:// redirects to https://');
    }
  } else {
    add({ id: 'no-https', severity: 'high', title: 'Your site has no HTTPS', why: 'Passwords and data travel in the clear.', fix: 'Put your site behind HTTPS. Caddy and most hosts do this for free.' });
  }

  checkHeaders(page, add, pass, https);

  const { own, thirdParty } = scriptSources(html, final);
  const queue = [...own];
  const seen = new Set(queue);
  let bytes = 0;
  let fetched = 0;
  let sourceMaps = 0;

  const results: string[] = [html];
  while (queue.length && fetched < MAX_SCRIPTS && bytes < MAX_TOTAL_BYTES && Date.now() < deadline) {
    const batch = queue.splice(0, 6);
    const responses = await Promise.all(batch.map((src) => safeFetch(src, { maxBytes: MAX_SCRIPT_BYTES, allowPrivate, redirects: 2 }).catch(() => null)));
    responses.forEach((res, index) => {
      if (res?.status !== 200) return;
      fetched++;
      bytes += res.body.length;
      const js = res.body.toString('utf8');
      results.push(js);
      if (/\/\/# sourceMappingURL=\S+\.map/.test(js)) sourceMaps++;
      for (const ref of chunkReferences(js, batch[index]!)) {
        if (!seen.has(ref)) {
          seen.add(ref);
          queue.push(ref);
        }
      }
    });
  }

  const combined = results.join('\n');
  const secretSeen = new Set<string>();
  for (const hit of findSecrets(combined)) {
    if (secretSeen.has(hit.masked)) continue;
    secretSeen.add(hit.masked);
    add({
      id: `secret-${hit.kind.toLowerCase().replaceAll(' ', '-')}`,
      severity: hit.severity,
      title: `${hit.kind} is visible to every visitor`,
      why: hit.severity === 'critical' ? 'It ships in the code your site sends to browsers, so anyone can copy it and use it as you.' : 'This key is in your public code. It may be fine, but only if it is locked to your domain.',
      fix: hit.severity === 'critical' ? 'Replace this key now, then move every call that uses it to your server.' : 'Restrict the key to your domain in the provider\'s console.',
      evidence: hit.masked,
    });
  }
  if (!secretSeen.size) pass(`No secrets found in ${fetched + 1} files`);

  if (/<(?:script|iframe|link)\b[^>]*(?:src|href)=["']http:\/\//i.test(html) && https) {
    add({ id: 'mixed-content', severity: 'medium', title: 'Some files load over plain http', why: 'Those files can be swapped by someone on the same network.', fix: 'Load every script and stylesheet over https.' });
  }
  if (sourceMaps) {
    add({ id: 'source-maps', severity: 'low', title: 'Your original source code may be public', why: 'Source maps let anyone read your code as you wrote it, which makes bugs easier to find.', fix: 'Turn off production source maps, or upload them to your error tracker instead.', evidence: `${sourceMaps} file${sourceMaps > 1 ? 's' : ''}` });
  }

  const supabase = findSupabase(combined);
  const firebase = /firebaseConfig|\.firebaseio\.com|firebaseapp\.com/.test(combined);
  const backend = supabase.url ? 'Supabase' : firebase ? 'Firebase' : undefined;

  const token = verifyToken(final.hostname);
  const verified = await isVerifiedOwner(final.origin, html, token, allowPrivate);
  const checksRun: string[] = [];

  if (verified) {
    await probeExposedFiles(final.origin, add, pass, allowPrivate);
    checksRun.push('Exposed files');
    if (supabase.url && supabase.anonKey) {
      const get: SupabaseFetch = async (url, headers) => {
        const res = await safeFetch(url, { headers, maxBytes: 1_000_000, redirects: 0 });
        return { status: res.status, body: res.body.toString() };
      };
      const rls = await probeSupabase(supabase.url, supabase.anonKey, get).catch(() => null);
      if (rls) {
        checksRun.push(`Database access for ${rls.checked} tables`);
        if (rls.open.length) {
          add({
            id: 'rls-open', severity: 'critical',
            title: `${rls.open.length} database table${rls.open.length > 1 ? 's are' : ' is'} readable by anyone`,
            why: 'A visitor with no account can read these rows using the public key in your site. This is the same mistake behind the 2025 Lovable data leaks.',
            fix: 'Turn on Row Level Security for these tables, and add policies so people only see their own rows.',
            evidence: rls.open.join(', '),
          });
        } else pass(`No anonymous access to ${rls.checked} database tables`);
      }
    }
  } else if (supabase.url) {
    add({
      id: 'supabase-unverified', severity: 'info', title: 'Supabase found: confirm your database rules',
      why: 'The public key is meant to be visible, so your database rules (RLS) are all that protect your data. We only test them once you prove the site is yours.',
      fix: 'Publish the verification token shown below, then scan again.', evidence: supabase.url,
    });
  }

  findings.sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
  const score = Math.max(0, 100 - findings.reduce((sum, f) => sum + PENALTY[f.severity], 0));
  const actionable = findings.filter((f) => f.severity !== 'info');

  return {
    url: target.href,
    finalUrl: final.href,
    scannedAt: new Date().toISOString(),
    grade: gradeFor(score, findings),
    score,
    platform: { ...detectPlatform(page, html), backend },
    tls,
    findings,
    passed,
    stats: { scripts: fetched, bytes, thirdPartyScripts: thirdParty },
    owner: { verified, token, checksRun },
    fixPrompt: actionable.length
      ? `A security scan of my app found these problems. Fix them one by one, and tell me about anything I have to do myself (like replacing a key).\n\n${actionable.map((f, i) => `${i + 1}. ${f.title}. ${f.fix}`).join('\n')}`
      : '',
  };
}
