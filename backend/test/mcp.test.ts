import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Starts the real MCP server over stdio, the way a coding agent would.
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'air-mcp-'));
const project = path.join(tmp, 'shop');
let site: http.Server;
let client: Client;
let stderr = '';

before(async () => {
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'shop', scripts: { build: 'vite build' }, devDependencies: { vite: '^6.0.0' } }));
  fs.writeFileSync(path.join(project, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(project, 'index.html'), '<div id="app"></div><script type="module" src="/src/main.js"></script>');
  fs.writeFileSync(path.join(project, 'src', 'main.js'), 'document.title = import.meta.env.VITE_TITLE;');

  site = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html><body>hello</body></html>');
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp.ts'],
    cwd: backend,
    env: { ...process.env, DATA_DIR: tmp, LOG_DIR: tmp, LOG_LEVEL: 'silent' } as Record<string, string>,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => (stderr += chunk));
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  site?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const call = async (name: string, args: object) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  assert.ok(!res.isError, `${name} failed: ${res.content[0]?.text}\n${stderr}`);
  return JSON.parse(res.content[0]!.text);
};

test('the MCP server lists its three tools', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['quote_cloud', 'rescue_project', 'scan_url']);
});

test('quote_cloud returns three options inside the EU', async () => {
  const quote = await call('quote_cloud', { monthly_budget: 20, eu_only: true });
  assert.deepEqual(quote.options.map((o: { label: string }) => o.label), ['Budget', 'Balanced', 'Premium']);
});

test('scan_url grades a local site', async () => {
  const { port } = site.address() as AddressInfo;
  const report = await call('scan_url', { url: `http://127.0.0.1:${port}/` });
  assert.match(report.grade, /^[A-F]$/);
  assert.ok(report.findings.length > 0);
});

test('rescue_project builds a kit from a local folder', async () => {
  const result = await call('rescue_project', { source: project });
  assert.equal(result.analysis.stack, 'vite');
  assert.ok(result.kit['deploy/docker-compose.yml']);
  assert.match(result.kit['deploy/Dockerfile'], /ARG VITE_TITLE/);
});
