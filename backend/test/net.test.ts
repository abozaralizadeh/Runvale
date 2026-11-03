import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BlockedTargetError, isPublicAddress, parseTarget, safeFetch } from '../src/net.ts';

test('only public unicast addresses count as public', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', 'nonsense']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test('dangerous targets are refused before any connection', () => {
  const blocked = ['file:///etc/passwd', 'ftp://example.com', 'http://127.0.0.1', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'https://user:pw@example.com', 'https://example.com:22'];
  for (const url of blocked) assert.throws(() => parseTarget(url, false), BlockedTargetError, url);
});

test('a bare domain becomes https', () => {
  assert.equal(parseTarget('example.com', false).href, 'https://example.com/');
});

test('hostnames that resolve to private addresses are refused at connect time', async () => {
  await assert.rejects(() => safeFetch('http://localhost/', { allowPrivate: false, timeoutMs: 3_000 }), /private address/);
});
