import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

// This file runs with the public defaults: no access to private addresses.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'air-api-'));
process.env.DATA_DIR = tmp;
process.env.LOG_DIR = tmp;
process.env.PUBLIC_DIR = path.join(tmp, 'none');
process.env.LOG_LEVEL = 'silent';
delete process.env.ALLOW_PRIVATE_TARGETS;

const { buildApp } = await import('../src/app.ts');
let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  app = await buildApp();
});
after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (url: string, payload: object, headers = {}) => app.inject({ method: 'POST', url, payload, headers });

test('the public API refuses internal targets', async () => {
  for (const url of ['http://127.0.0.1:8787/api/health', 'http://169.254.169.254/latest/meta-data', 'http://localhost', 'file:///etc/passwd']) {
    const res = await post('/api/scan', { url });
    assert.equal(res.statusCode, 400, `${url}: ${res.body}`);
  }
});

test('security headers are on', async () => {
  const res = await app.inject({ url: '/api/health' });
  assert.match(String(res.headers['content-security-policy']), /default-src 'self'/);
  assert.ok(res.headers['strict-transport-security']);
});

test('quote validates input', async () => {
  assert.equal((await post('/api/quote', { monthlyBudget: -1 })).statusCode, 400);
  assert.equal((await post('/api/quote', { monthlyBudget: 30 })).json().options.length, 3);
});

test('rescue only accepts GitHub addresses, never local paths', async () => {
  for (const repoUrl of ['/etc', '../..', 'file:///etc', 'https://evil.com/a/b']) {
    const res = await post('/api/rescue', { repoUrl });
    assert.equal(res.statusCode, 400, repoUrl);
  }
});

test('deploy rejects bad input before touching a provider', async () => {
  const base = { token: 'x'.repeat(30), repoUrl: 'https://github.com/a/b', serverType: 'cx23', location: 'nbg1', sshPublicKey: 'ssh-ed25519 AAAA me' };
  assert.equal((await post('/api/deploy/hetzner', { ...base, sshPublicKey: 'not a key\nruncmd: evil' })).statusCode, 400);
  assert.equal((await post('/api/deploy/hetzner', { ...base, domain: 'x; rm -rf /' })).statusCode, 400);
});

test('watches need a workspace key', async () => {
  assert.equal((await app.inject({ url: '/api/watches' })).statusCode, 400);
  const res = await app.inject({ url: '/api/watches', headers: { 'x-workspace': 'a'.repeat(40) } });
  assert.deepEqual(res.json(), []);
});

test('scans are rate limited', async () => {
  let limited = false;
  for (let i = 0; i < 15 && !limited; i++) limited = (await post('/api/scan', { url: 'http://10.0.0.1' })).statusCode === 429;
  assert.ok(limited);
});
