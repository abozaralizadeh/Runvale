import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { probeSupabase, scanUrl, verifyToken } from '../src/scanner.ts';
import { findSecrets, findSupabase, jwtRole, mask } from '../src/secrets.ts';

const jwt = (payload: object) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2lnbmF0dXJlLXBhcnQtaGVyZQ`;
const stripe = ['sk', 'live', 'abcdefghijklmnopqrstuvwx1234'].join('_');
const service = jwt({ role: 'service_role', iss: 'supabase' });
const anon = jwt({ role: 'anon', iss: 'supabase' });

const hits: string[] = [];
let leaky: http.Server;
let clean: http.Server;
let verified: http.Server;
let leakyUrl: string;
let cleanUrl: string;
let verifiedUrl: string;

const listen = (server: http.Server) => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)));

before(async () => {
  leaky = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    res.setHeader('x-powered-by', 'Express');
    res.setHeader('set-cookie', 'session=abc');
    if (req.url === '/assets/index-abc.js') return res.end(`const s="${stripe}";const k="${service}";import("./chunk-xyz.js");\n//# sourceMappingURL=index.js.map`);
    if (req.url === '/assets/chunk-xyz.js') return res.end(`const u="https://abcdefghijklmnopqrst.supabase.co";const a="${anon}"`);
    if (req.url === '/.env') return res.end('SECRET_KEY=abc\n');
    res.end('<html><script type="module" src="/assets/index-abc.js"></script></html>');
  });
  clean = http.createServer((_req, res) => {
    res.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'none'");
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.end('<html><h1>hi</h1></html>');
  });
  verified = http.createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0]!;
    if (req.url === '/.well-known/runvale-verify.txt') return res.end(verifyToken(host));
    if (req.url === '/.env') return res.end('SECRET_KEY=abc\n');
    res.end('<html></html>');
  });
  [leakyUrl, cleanUrl, verifiedUrl] = await Promise.all([listen(leaky), listen(clean), listen(verified)]);
});

after(() => {
  leaky.close();
  clean.close();
  verified.close();
});

test('secrets in bundles and chunks fail the site and stay masked', async () => {
  const report = await scanUrl(leakyUrl, { allowPrivate: true });
  assert.equal(report.grade, 'F');
  assert.ok(report.findings.some((f) => f.title.startsWith('Stripe live secret key')));
  assert.ok(report.findings.some((f) => f.title.startsWith('Supabase service_role key')));
  assert.ok(report.findings.some((f) => f.id === 'version-leak'));
  assert.ok(report.findings.some((f) => f.id === 'weak-cookies'));
  assert.ok(report.findings.some((f) => f.id === 'source-maps'));
  assert.equal(report.platform.backend, 'Supabase');
  assert.ok(hits.includes('/assets/chunk-xyz.js'), 'follows imported chunks');
  const output = JSON.stringify(report);
  assert.ok(!output.includes(stripe), 'never returns the full secret');
  assert.ok(!output.includes(service), 'never returns the full token');
  assert.match(report.fixPrompt, /Stripe live secret key/);
});

test('sites we cannot prove are yours never get file probes', async () => {
  hits.length = 0;
  const report = await scanUrl(leakyUrl, { allowPrivate: true });
  assert.equal(report.owner.verified, false);
  assert.ok(!hits.includes('/.env'));
  assert.ok(report.findings.some((f) => f.id === 'supabase-unverified'));
});

test('verified owners get the deeper checks', async () => {
  const report = await scanUrl(verifiedUrl, { allowPrivate: true });
  assert.equal(report.owner.verified, true);
  assert.ok(report.findings.some((f) => f.id === 'exposed/.env' && f.severity === 'critical'));
});

test('a well-configured site scores well, and http is called out', async () => {
  const report = await scanUrl(cleanUrl, { allowPrivate: true });
  assert.ok(report.findings.some((f) => f.id === 'no-https'));
  assert.equal(report.findings.filter((f) => f.severity === 'critical').length, 0);
  assert.ok(report.passed.includes('Content Security Policy is set'));
});

test('analytics cookies are left alone, login cookies are not', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('set-cookie', ['_ga=1; Path=/', 'session_id=2; Path=/']);
    res.end('<html></html>');
  });
  const url = await listen(server);
  const report = await scanUrl(url, { allowPrivate: true });
  server.close();
  assert.equal(report.findings.find((f) => f.id === 'weak-cookies')?.evidence, 'session_id');
});

test('probeSupabase reports tables with rows and forgets the rows', async () => {
  const result = await probeSupabase('https://x.supabase.co', 'key', async (url) => {
    if (url.endsWith('/rest/v1/')) return { status: 200, body: JSON.stringify({ definitions: { users: {}, posts: {}, locked: {} } }) };
    if (url.includes('/users?')) return { status: 200, body: '[{"email":"a@b.c"}]' };
    if (url.includes('/posts?')) return { status: 200, body: '[]' };
    return { status: 401, body: '{}' };
  });
  assert.deepEqual(result, { checked: 3, open: ['users'] });
});

test('secret helpers', () => {
  assert.equal(jwtRole(service), 'service_role');
  assert.equal(mask('abc'), '••••');
  assert.equal(findSecrets(`x ${anon} y`).length, 0, 'the anon key is meant to be public');
  assert.equal(findSecrets('postgres://user:hunter22@db.example.com/app')[0]?.severity, 'critical');
  assert.equal(findSecrets('postgres://user:${PASSWORD}@db/app').length, 0, 'templates are not secrets');
  assert.deepEqual(findSupabase(`https://abcdefghijklmnopqrst.supabase.co ${anon}`), { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: anon });
});
