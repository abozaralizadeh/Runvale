import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'air-watch-'));
process.env.DATA_DIR = tmp;
process.env.LOG_DIR = tmp;
process.env.LOG_LEVEL = 'silent';
process.env.ALLOW_PRIVATE_TARGETS = '1';
process.env.WATCH_INTERVAL_MS = '0';

const { addWatch, listWatches, removeWatch, runDueChecks } = await import('../src/watch.ts');

let healthy = true;
const site = http.createServer((_req, res) => {
  res.statusCode = healthy ? 200 : 503;
  res.end('<html></html>');
});
const alerts: string[] = [];
const hook = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    alerts.push(JSON.parse(raw).text);
    res.end('ok');
  });
});

after(() => {
  site.close();
  hook.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const url = (s: http.Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}/`;

test('a site going down and back up is logged and alerted once each', async () => {
  await Promise.all([new Promise<void>((r) => site.listen(0, '127.0.0.1', r)), new Promise<void>((r) => hook.listen(0, '127.0.0.1', r))]);
  const watch = await addWatch(A, { url: url(site), label: 'Shop', notifyUrl: url(hook) });
  assert.equal(watch.status, 'up');
  assert.ok(watch.grade);

  healthy = false;
  await runDueChecks();
  assert.equal(listWatches(A)[0]!.status, 'up', 'one failure is not an outage');
  await runDueChecks();
  await runDueChecks();
  assert.equal(listWatches(A)[0]!.status, 'down');
  assert.deepEqual(alerts, ['Shop is down (HTTP 503)']);

  healthy = true;
  await runDueChecks();
  const after = listWatches(A)[0]!;
  assert.equal(after.status, 'up');
  assert.deepEqual(alerts, ['Shop is down (HTTP 503)', 'Shop is back up']);
  assert.ok(after.uptime! < 100);
  assert.ok(after.events.some((e: any) => e.kind === 'down'));
});

test('workspaces cannot see or delete each other', () => {
  const [watch] = listWatches(A);
  assert.deepEqual(listWatches(B), []);
  assert.equal(removeWatch(B, watch!.id), false);
  assert.equal(listWatches(A).length, 1);
  assert.equal(removeWatch(A, watch!.id), true);
});
