import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

// The shared-server setup: under /runvale/ behind a local proxy, with the server's own addresses blocked and small daily caps.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'air-shared-'));
const pub = path.join(tmp, 'public');
fs.mkdirSync(pub);
fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><title>Runvale</title>');
process.env.DATA_DIR = tmp;
process.env.LOG_DIR = tmp;
process.env.PUBLIC_DIR = pub;
process.env.LOG_LEVEL = 'silent';
process.env.BASE_PATH = '/runvale/';
process.env.TRUST_PROXY = '127.0.0.1';
process.env.SCAN_BLOCKLIST = 'self.example.test, 203.0.113.7';
process.env.SELF_ADDRESSES = '198.51.100.9';
process.env.SCANS_PER_IP_DAILY = '2';
delete process.env.ALLOW_PRIVATE_TARGETS;

const { buildApp } = await import('../src/app.ts');
const { blocklist, parseTarget, BlockedTargetError } = await import('../src/net.ts');
const { DailyQuota, QuotaError } = await import('../src/quota.ts');
let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  app = await buildApp();
});
after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the app answers under the base path, stripped by the proxy or not', async () => {
  for (const url of ['/api/health', '/runvale/api/health']) {
    const res = await app.inject({ url });
    assert.equal(res.statusCode, 200, url);
    assert.deepEqual(res.json(), { ok: true });
  }
  for (const url of ['/', '/runvale/']) {
    const res = await app.inject({ url });
    assert.equal(res.statusCode, 200, url);
    assert.match(res.body, /<title>Runvale/);
  }
  assert.equal((await app.inject({ url: '/runvale/api/nope' })).statusCode, 404);
});

test('the bare base path redirects to the slash version', async () => {
  const res = await app.inject({ url: '/runvale' });
  assert.equal(res.statusCode, 301);
  assert.equal(res.headers.location, '/runvale/');
});

test('no HSTS header under a path, since it would cover the whole host', async () => {
  const res = await app.inject({ url: '/runvale/api/health' });
  assert.equal(res.headers['strict-transport-security'], undefined);
  assert.match(String(res.headers['content-security-policy']), /default-src 'self'/);
});

test('the server refuses to scan itself, by name or by IP', () => {
  for (const url of ['https://self.example.test', 'https://SELF.example.test./x', 'https://www.self.example.test', 'http://203.0.113.7', 'http://198.51.100.9/', 'http://[::ffff:203.0.113.7]/']) {
    assert.throws(() => parseTarget(url, false), BlockedTargetError, url);
  }
  // Even with private targets allowed for local runs, its own addresses stay blocked.
  assert.throws(() => parseTarget('http://203.0.113.7', true), BlockedTargetError);
  assert.doesNotThrow(() => parseTarget('https://example.com', false));
});

test('the blocklist matches names, subdomains and IPv4 inside IPv6', () => {
  const list = blocklist(['max.example.test', '72.0.2.8', '[2001:db8::1]']);
  assert.equal(list.name('max.example.test'), true);
  assert.equal(list.name('a.max.example.test'), true);
  assert.equal(list.name('notmax.example.test'), false);
  assert.equal(list.address('72.0.2.8'), true);
  assert.equal(list.address('::ffff:72.0.2.8'), true);
  assert.equal(list.address('2001:0db8:0:0:0:0:0:1'), true);
  assert.equal(list.address('72.0.2.9'), false);
});

test('the private ranges from the fair-use rules are all refused', () => {
  for (const url of ['http://127.0.0.5', 'http://10.1.2.3', 'http://172.20.0.1', 'http://192.168.0.10', 'http://169.254.169.254', 'http://[::1]', 'http://[fd12::1]', 'http://[fc00::1]']) {
    assert.throws(() => parseTarget(url, false), BlockedTargetError, url);
  }
});

test('daily scan cap per IP, keyed on the address the proxy passes on', async () => {
  const scan = (ip: string) => app.inject({ method: 'POST', url: '/runvale/api/scan', payload: { url: 'http://10.0.0.1' }, remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': ip } });
  assert.equal((await scan('192.0.2.50')).statusCode, 400);
  assert.equal((await scan('192.0.2.50')).statusCode, 400);
  const third = await scan('192.0.2.50');
  assert.equal(third.statusCode, 429);
  assert.match(third.json().error, /today/);
  assert.equal((await scan('192.0.2.51')).statusCode, 400, 'another visitor still has scans left');
});

test('a forwarded address from anyone but the local proxy is ignored', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/scan', payload: { url: 'http://10.0.0.1' }, remoteAddress: '192.0.2.99', headers: { 'x-forwarded-for': '192.0.2.50' } });
  assert.equal(res.statusCode, 400, 'counted against 192.0.2.99, not the capped 192.0.2.50');
});

test('the daily quota has a total cap too', () => {
  const quota = new DailyQuota('things', 5, 2);
  quota.take('a');
  quota.take('b');
  assert.throws(() => quota.take('c'), QuotaError);
});
