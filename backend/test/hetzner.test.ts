import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const calls: { method: string; url: string; body: any; auth?: string }[] = [];
let mode: 'ok' | 'nostock' = 'ok';

const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method!, url: req.url!, body, auth: req.headers.authorization });
    const send = (status: number, data: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== 'Bearer good-token-good-token-1234') return send(401, { error: { code: 'unauthorized', message: 'nope' } });
    if (req.url?.startsWith('/server_types')) {
      return send(200, { server_types: [
        { id: 1, name: 'cx23', cores: 2, memory: 4, disk: 40, architecture: 'x86', deprecation: null, prices: [{ location: 'nbg1', price_monthly: { net: '5.4900', gross: '6.53' } }] },
        { id: 2, name: 'cax11', cores: 2, memory: 4, disk: 40, architecture: 'arm', deprecation: null, prices: [{ location: 'nbg1', price_monthly: { net: '5.99', gross: '7' } }] },
        { id: 3, name: 'cpx22', cores: 2, memory: 4, disk: 40, architecture: 'x86', deprecation: null, prices: [{ location: 'fsn1', price_monthly: { net: '19.49', gross: '23' } }] },
      ] });
    }
    if (req.url?.startsWith('/datacenters')) return send(200, { datacenters: [{ location: { name: 'nbg1' }, server_types: { available: [] } }, { location: { name: 'fsn1' }, server_types: { available: [3] } }] });
    if (req.url?.startsWith('/ssh_keys') && req.method === 'GET') return send(200, { ssh_keys: [] });
    if (req.url === '/ssh_keys') return send(201, { ssh_key: { id: 77 } });
    if (req.url === '/servers') {
      if (mode === 'nostock') return send(412, { error: { code: 'resource_unavailable', message: 'gone' } });
      return send(201, { server: { id: 9, name: body.name, status: 'initializing', public_net: { ipv4: { ip: '203.0.113.10' } } } });
    }
    send(404, {});
  });
});

let hetzner: typeof import('../src/hetzner.ts');

before(async () => {
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  process.env.HETZNER_API = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  hetzner = await import('../src/hetzner.ts');
});

after(() => fake.close());

const GOOD = 'good-token-good-token-1234';

test('preflight shows real prices and stock, and skips Arm', async () => {
  const { options } = await hetzner.preflight(GOOD);
  assert.deepEqual(options.map((o) => [o.name, o.monthlyNet, o.available]), [['cx23', 5.49, false], ['cpx22', 19.49, true]]);
});

test('a bad token gets a plain answer', async () => {
  await assert.rejects(() => hetzner.preflight('wrong-token-wrong-token'), /rejected that token/);
});

test('creating a server sends the setup file and SSH key', async () => {
  const server = await hetzner.createServer(GOOD, { name: 'shop', serverType: 'cx23', location: 'nbg1', sshPublicKey: 'ssh-ed25519 AAAA me', userData: '#cloud-config\n' });
  const create = calls.find((c) => c.url === '/servers')!;
  assert.equal(create.body.user_data, '#cloud-config\n');
  assert.deepEqual(create.body.ssh_keys, [77]);
  assert.equal(create.body.image, 'ubuntu-24.04');
  assert.equal(server.siteUrl, 'https://203-0-113-10.sslip.io');
});

test('no stock is explained', async () => {
  mode = 'nostock';
  await assert.rejects(() => hetzner.createServer(GOOD, { name: 's', serverType: 'cx23', location: 'nbg1', sshPublicKey: 'ssh-ed25519 AAAA', userData: 'x' }), /no stock/);
});
