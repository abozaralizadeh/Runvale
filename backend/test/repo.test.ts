import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { cloudInit, generateKit } from '../src/kit.ts';
import { analyze, parseGithubUrl, RepoError, type RepoFiles } from '../src/repo.ts';

const repo = (files: Record<string, string>): RepoFiles => new Map(Object.entries(files));
const pkg = (p: object) => JSON.stringify(p);

test('GitHub addresses are parsed and anything else refused', () => {
  assert.deepEqual(parseGithubUrl('https://github.com/a/b.git'), { owner: 'a', repo: 'b', ref: undefined, url: 'https://github.com/a/b' });
  assert.equal(parseGithubUrl('github.com/a/b/tree/dev').ref, 'dev');
  for (const bad of ['https://evil.com/a/b', 'https://github.com/a', 'https://github.com.evil.com/a/b', 'a; rm -rf /']) assert.throws(() => parseGithubUrl(bad), RepoError, bad);
});

test('stacks are detected', () => {
  const cases: [Record<string, string>, string][] = [
    [{ 'package.json': pkg({ dependencies: { next: '15' }, scripts: { build: 'next build', start: 'next start' } }) }, 'nextjs'],
    [{ 'package.json': pkg({ devDependencies: { vite: '6' }, scripts: { build: 'vite build' } }) }, 'vite'],
    [{ 'package.json': pkg({ dependencies: { express: '5' }, scripts: { start: 'node server.js' } }) }, 'node'],
    [{ 'requirements.txt': 'fastapi\n', 'app/main.py': 'from fastapi import FastAPI\napi = FastAPI()\n' }, 'fastapi'],
    [{ 'requirements.txt': 'flask\n', 'app.py': 'from flask import Flask\napp = Flask(__name__)\n' }, 'flask'],
    [{ 'requirements.txt': 'django\n', 'manage.py': '', 'shop/wsgi.py': '' }, 'django'],
    [{ 'index.html': '<h1>hi</h1>' }, 'static'],
    [{ Dockerfile: 'FROM node\nEXPOSE 4000\nUSER app\n' }, 'dockerfile'],
    [{ 'README.md': 'nothing' }, 'unknown'],
  ];
  for (const [files, stack] of cases) assert.equal(analyze(repo(files), 'x').stack, stack);
  assert.equal(analyze(repo({ 'requirements.txt': 'fastapi\n', 'app/main.py': 'api = FastAPI()\n' }), 'x').pythonEntry, 'app.main:api');
  assert.equal(analyze(repo({ Dockerfile: 'FROM node\nEXPOSE 4000\n' }), 'x').port, 4000);
});

test('code problems are found', () => {
  const stripe = ['sk', 'live', 'abcdefghijklmnopqrstuvwx1234'].join('_');
  const a = analyze(repo({
    'package.json': pkg({ dependencies: { '@supabase/supabase-js': '2' }, devDependencies: { vite: '6' }, scripts: { build: 'vite build' } }),
    '.env': 'X=1',
    'src/pay.ts': `const key = "${stripe}"; console.log(import.meta.env.VITE_STRIPE_SECRET_KEY, import.meta.env.VITE_SUPABASE_ANON_KEY, process.env.NODE_ENV);`,
    'supabase/migrations/1.sql': 'create table public.users (id int); create table posts (id int); alter table posts enable row level security;',
  }), 'x');
  const ids = a.findings.map((f) => f.id);
  assert.ok(ids.includes('env-committed'));
  assert.ok(ids.some((i) => i.startsWith('repo-secret-Stripe')));
  assert.ok(ids.includes('public-env-secret'));
  assert.ok(ids.includes('gitignore-env'));
  assert.ok(ids.includes('no-lockfile'));
  assert.equal(a.findings.find((f) => f.id === 'rls-missing')?.evidence, 'users');
  assert.deepEqual(a.publicEnvVars, ['VITE_STRIPE_SECRET_KEY', 'VITE_SUPABASE_ANON_KEY']);
  assert.ok(!a.envVars.includes('NODE_ENV'));
  assert.ok(!JSON.stringify(a).includes(stripe));
});

test('the kit is valid YAML and carries no secrets by default', () => {
  const a = analyze(repo({ 'package.json': pkg({ dependencies: { next: '15', pg: '8' }, scripts: { build: 'next build', start: 'next start' } }), '.env.example': 'API_KEY=\n' }), 'Shop App');
  const kit = generateKit(a, { repoUrl: 'https://github.com/a/b', sshPublicKey: 'ssh-ed25519 AAAAC3Nza me@x' });
  const compose = parse(kit['deploy/docker-compose.yml']!);
  assert.deepEqual(Object.keys(compose.services).sort(), ['app', 'caddy', 'db']);
  assert.equal(compose.services.db.ports, undefined, 'the database is never published');
  assert.deepEqual(compose.services.app.cap_drop, ['ALL']);
  assert.equal(compose.services.app.environment.DATABASE_URL, 'postgres://app:${POSTGRES_PASSWORD}@db:5432/app');

  const initText = kit['deploy/cloud-init.yaml']!;
  assert.ok(initText.startsWith('#cloud-config\n'));
  const init = parse(initText);
  assert.equal(init.ssh_pwauth, false);
  assert.deepEqual(init.users[0].ssh_authorized_keys, ['ssh-ed25519 AAAAC3Nza me@x']);
  assert.ok(!init.write_files.some((f: { path: string }) => f.path === '/opt/airchitect/.env'));
  assert.ok(Buffer.byteLength(initText) < 32_000);
  assert.ok(kit['deploy/Dockerfile']!.includes('USER node'));
  assert.ok(kit['deploy/.env.example']!.includes('API_KEY='));
  assert.ok(!kit['deploy/.env.example']!.includes('DATABASE_URL'));
  assert.equal(parse(kit['airchitect.yaml']!).metadata.name, 'shop-app');
});

test('settings only reach the server through a private file', () => {
  const a = analyze(repo({ 'index.html': '' }), 'site');
  const kit = generateKit(a);
  const init = parse(cloudInit(kit, { env: 'TOKEN=abc\n' }));
  const env = init.write_files.find((f: { path: string }) => f.path === '/opt/airchitect/.env');
  assert.equal(env.permissions, '0600');
  assert.equal(Buffer.from(env.content, 'base64').toString(), 'TOKEN=abc\n');
});

test('build-time variables are passed to the image build', () => {
  const a = analyze(repo({ 'package.json': pkg({ devDependencies: { vite: '6' }, scripts: { build: 'vite build' } }), 'src/a.ts': 'import.meta.env.VITE_API_URL' }), 'x');
  const kit = generateKit(a);
  assert.ok(kit['deploy/Dockerfile']!.includes('ARG VITE_API_URL'));
  assert.equal(parse(kit['deploy/docker-compose.yml']!).services.app.build.args.VITE_API_URL, '${VITE_API_URL:-}');
});
