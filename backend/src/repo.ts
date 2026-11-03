import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { safeFetch } from './net.js';
import type { Finding } from './scanner.js';
import { findSecrets } from './secrets.js';

export type RepoFiles = Map<string, string>;

const SKIP_DIR = /(^|\/)(node_modules|dist|build|\.next|\.nuxt|\.output|\.git|\.venv|venv|__pycache__|vendor|coverage|\.turbo|\.vercel)\//;
const TEXT_FILE = /\.(m?[jt]sx?|cjs|json|ya?ml|toml|py|prisma|sql|html|vue|svelte|astro|txt|md|lock|env|example|sample|ini|cfg)$|(^|\/)(Dockerfile|Procfile|\.env[^/]*|\.gitignore|requirements[^/]*|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|manage\.py)$/;
const MAX_FILE_BYTES = 400_000;
const MAX_FILES = 4_000;
const MAX_ZIP_BYTES = 60_000_000;
const MAX_TOTAL_BYTES = 150_000_000;

const wanted = (name: string, size: number) => !SKIP_DIR.test(`/${name}`) && TEXT_FILE.test(name) && size <= MAX_FILE_BYTES;

export function parseGithubUrl(input: string): { owner: string; repo: string; ref?: string; url: string } {
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w./-]+?))?\/?$/.exec(input.trim());
  if (!match) throw new RepoError('Paste a public GitHub address, like https://github.com/you/your-app');
  const [, owner, repo, ref] = match;
  return { owner: owner!, repo: repo!, ref, url: `https://github.com/${owner}/${repo}` };
}

export class RepoError extends Error {}

export async function loadGithub(input: string): Promise<{ files: RepoFiles; name: string; repoUrl: string; ref?: string }> {
  const { owner, repo, ref, url } = parseGithubUrl(input);
  const res = await safeFetch(`https://codeload.github.com/${owner}/${repo}/zip/${ref ? `refs/heads/${ref}` : 'HEAD'}`, {
    maxBytes: MAX_ZIP_BYTES,
    timeoutMs: 30_000,
    allowPrivate: false,
  });
  if (res.status === 404) throw new RepoError("We can't see that repo. It has to be public for now.");
  if (res.status !== 200) throw new RepoError(`GitHub answered with an error (${res.status}).`);
  if (res.truncated) throw new RepoError('That repo is too big for the free version (60 MB zipped).');

  let total = 0;
  let count = 0;
  const entries = unzipSync(new Uint8Array(res.body), {
    filter: ({ name, originalSize }) => {
      total += originalSize;
      if (total > MAX_TOTAL_BYTES) throw new RepoError('That repo is too big for the free version.');
      const relative = name.split('/').slice(1).join('/');
      if (!relative || !wanted(relative, originalSize)) return false;
      return ++count <= MAX_FILES;
    },
  });
  const files: RepoFiles = new Map();
  for (const [name, data] of Object.entries(entries)) {
    files.set(name.split('/').slice(1).join('/'), Buffer.from(data).toString('utf8'));
  }
  return { files, name: repo, repoUrl: url, ref };
}

export function loadDir(dir: string): { files: RepoFiles; name: string; repoUrl?: string } {
  const root = path.resolve(dir);
  const files: RepoFiles = new Map();
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isSymbolicLink() || files.size >= MAX_FILES) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIR.test(`/${relative}/`)) walk(full);
      } else if (entry.isFile() && wanted(relative, fs.statSync(full).size)) {
        files.set(relative, fs.readFileSync(full, 'utf8'));
      }
    }
  };
  walk(root);
  let repoUrl: string | undefined;
  try {
    const gitConfig = fs.readFileSync(path.join(root, '.git', 'config'), 'utf8');
    const remote = /url = (?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\s/.exec(gitConfig);
    if (remote) repoUrl = `https://github.com/${remote[1]}`;
  } catch {
    /* not a git checkout */
  }
  return { files, name: path.basename(root), repoUrl };
}

export type Stack = 'nextjs' | 'vite' | 'node' | 'fastapi' | 'flask' | 'django' | 'static' | 'dockerfile' | 'unknown';
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export type Database = 'postgres' | 'supabase' | 'firebase' | 'mongodb' | 'mysql' | 'sqlite' | 'none';

export interface Analysis {
  name: string;
  stack: Stack;
  stackLabel: string;
  packageManager: PackageManager;
  port: number;
  startCommand?: string;
  pythonEntry?: string;
  outputDir: string;
  hasBuildScript: boolean;
  database: Database;
  needsPostgres: boolean;
  envVars: string[];
  publicEnvVars: string[];
  findings: Finding[];
  passed: string[];
  fileCount: number;
  dependencies: { name: string; version: string }[];
}

const STACK_LABEL: Record<Stack, string> = {
  nextjs: 'Next.js', vite: 'Vite (static)', node: 'Node.js server', fastapi: 'FastAPI', flask: 'Flask',
  django: 'Django', static: 'Static site', dockerfile: 'Has its own Dockerfile', unknown: 'Not recognised',
};

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  main?: string;
  name?: string;
}

function readPackage(files: RepoFiles): PackageJson | null {
  const raw = files.get('package.json');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

function detectPython(files: RepoFiles) {
  const requirements = [...files.entries()].filter(([f]) => /^requirements[^/]*\.txt$|^pyproject\.toml$/.test(f)).map(([, c]) => c).join('\n').toLowerCase();
  if (files.has('manage.py') || /\bdjango\b/.test(requirements)) {
    const wsgi = [...files.keys()].find((f) => /^[\w-]+\/wsgi\.py$/.test(f));
    return { stack: 'django' as const, entry: wsgi ? `${wsgi.split('/')[0]}.wsgi:application` : undefined };
  }
  const entryFor = (marker: RegExp, variable: RegExp) => {
    for (const [file, content] of files) {
      if (!file.endsWith('.py') || !marker.test(content)) continue;
      const name = variable.exec(content)?.[1] ?? 'app';
      return `${file.replace(/\.py$/, '').replaceAll('/', '.')}:${name}`;
    }
    return undefined;
  };
  if (/\bfastapi\b/.test(requirements)) return { stack: 'fastapi' as const, entry: entryFor(/\bFastAPI\(/, /^(\w+)\s*=\s*FastAPI\(/m) };
  if (/\bflask\b/.test(requirements)) return { stack: 'flask' as const, entry: entryFor(/\bFlask\(/, /^(\w+)\s*=\s*Flask\(/m) };
  return null;
}

function collectEnvVars(files: RepoFiles) {
  const vars = new Set<string>();
  const PLATFORM = new Set(['NODE_ENV', 'PORT', 'HOSTNAME', 'PATH', 'HOME', 'CI', 'DEV', 'PROD', 'MODE', 'BASE_URL', 'SSR', 'NEXT_RUNTIME', 'VERCEL', 'VERCEL_URL', 'VERCEL_ENV']);
  for (const [file, content] of files) {
    if (/(^|\/)\.env\.(example|sample|template)$/.test(file)) {
      for (const [, name] of content.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)) vars.add(name!);
    }
    if (!/\.(m?[jt]sx?|cjs|vue|svelte|astro|py)$/.test(file)) continue;
    for (const [, name] of content.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) vars.add(name!);
    for (const [, name] of content.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) vars.add(name!);
    for (const [, name] of content.matchAll(/import\.meta\.env\.([A-Z][A-Z0-9_]*)/g)) vars.add(name!);
    for (const [, name] of content.matchAll(/os\.(?:environ\.get\(|environ\[|getenv\()['"]([A-Z][A-Z0-9_]*)['"]/g)) vars.add(name!);
  }
  return [...vars].filter((v) => !PLATFORM.has(v)).sort();
}

function checkCode(files: RepoFiles, envVars: string[], isClientBuild: boolean) {
  const findings: Finding[] = [];
  const passed: string[] = [];

  const envFiles = [...files.keys()].filter((f) => /(^|\/)\.env(\.[\w-]+)?$/.test(f) && !/\.(example|sample|template)$/.test(f));
  if (envFiles.length) {
    findings.push({ id: 'env-committed', severity: 'critical', title: `${envFiles.join(', ')} is committed to the repo`, why: "Everyone who can see the repo can see your passwords, and they stay in git history even if you delete the file.", fix: 'Delete the file, add it to .gitignore, and replace every secret in it.', evidence: envFiles.join(', ') });
  } else passed.push('No .env file committed');

  const secretFiles = new Map<string, string>();
  for (const [file, content] of files) {
    if (/\.(example|sample|md|lock)$|(^|\/)(test|tests|__tests__|fixtures)\/|lock\.json$|lock\.yaml$/.test(file)) continue;
    for (const hit of findSecrets(content)) {
      const key = `${hit.kind}:${hit.masked}`;
      if (!secretFiles.has(key)) secretFiles.set(key, file);
      if (!findings.some((f) => f.id === `repo-secret-${key}`)) {
        findings.push({ id: `repo-secret-${key}`, severity: hit.severity, title: `${hit.kind} in ${file}`, why: 'A secret in the code is a secret anyone with the repo can use.', fix: 'Move it to an environment variable and replace the key.', evidence: hit.masked });
      }
    }
  }
  if (!secretFiles.size) passed.push('No secrets found in the code');

  if (isClientBuild) {
    const leaked = envVars.filter((v) => /^(VITE_|NEXT_PUBLIC_|REACT_APP_)/.test(v) && /SECRET|PRIVATE|SERVICE_ROLE|PASSWORD|API_KEY$/.test(v) && !/PUBLISHABLE|ANON|SITE_KEY/.test(v));
    if (leaked.length) {
      findings.push({ id: 'public-env-secret', severity: 'high', title: 'Secrets are being sent to the browser', why: 'Variables starting with VITE_, NEXT_PUBLIC_ or REACT_APP_ are built into the public code.', fix: 'Rename them without the prefix and only use them on a server.', evidence: leaked.join(', ') });
    }
  }

  const gitignore = files.get('.gitignore') ?? '';
  if (!/(^|\n)\.env/.test(gitignore)) {
    findings.push({ id: 'gitignore-env', severity: 'medium', title: '.env is not in .gitignore', why: 'One careless commit puts your secrets in the repo.', fix: 'Add .env and .env.* to .gitignore.' });
  } else passed.push('.env is ignored by git');

  const openCors = [...files].find(([file, content]) => /\.(m?[jt]s)$/.test(file) && /cors\(\s*\)|origin:\s*['"]\*['"]/.test(content));
  if (openCors) {
    findings.push({ id: 'open-cors', severity: 'medium', title: 'Your API accepts calls from any website', why: 'Other sites can call your API from a visitor\'s browser.', fix: 'List your own domains in the CORS settings.', evidence: openCors[0] });
  }

  const hasSupabase = [...files.values()].some((c) => c.includes('@supabase/supabase-js') || c.includes('createClient('));
  const migrations = [...files.entries()].filter(([f]) => /supabase\/migrations\/.*\.sql$/.test(f));
  if (hasSupabase && migrations.length) {
    const sql = migrations.map(([, c]) => c).join('\n');
    const created = [...sql.matchAll(/create table (?:if not exists )?(?:public\.)?"?(\w+)"?/gi)].map((m) => m[1]!.toLowerCase());
    const secured = new Set([...sql.matchAll(/alter table (?:if exists )?(?:public\.)?"?(\w+)"?\s+enable row level security/gi)].map((m) => m[1]!.toLowerCase()));
    const open = [...new Set(created)].filter((t) => !secured.has(t));
    if (open.length) {
      findings.push({ id: 'rls-missing', severity: 'high', title: `${open.length} table${open.length > 1 ? 's have' : ' has'} no Row Level Security`, why: 'Without it, the public key in your site can read and change these tables.', fix: 'Add ALTER TABLE ... ENABLE ROW LEVEL SECURITY plus policies for each one.', evidence: open.join(', ') });
    } else if (created.length) passed.push('Row Level Security is on for every table');
  }

  const locks = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
  if (files.has('package.json') && !locks.some((l) => files.has(l))) {
    findings.push({ id: 'no-lockfile', severity: 'medium', title: 'No lockfile', why: 'Every install can pull different code, including a compromised package.', fix: 'Run npm install and commit package-lock.json.' });
  }
  return { findings, passed };
}

function detectDatabase(pkg: PackageJson | null, files: RepoFiles): Database {
  const deps = { ...pkg?.dependencies };
  const prisma = files.get('prisma/schema.prisma') ?? '';
  const requirements = (files.get('requirements.txt') ?? '').toLowerCase();
  if (deps['@supabase/supabase-js'] || requirements.includes('supabase')) return 'supabase';
  if (deps.firebase || deps['firebase-admin']) return 'firebase';
  if (deps.mongoose || deps.mongodb || requirements.includes('pymongo')) return 'mongodb';
  if (/provider\s*=\s*"mysql"/.test(prisma) || deps.mysql2) return 'mysql';
  if (/provider\s*=\s*"sqlite"/.test(prisma) || deps['better-sqlite3']) return 'sqlite';
  if (/provider\s*=\s*"postgres/.test(prisma) || deps.pg || deps.postgres || deps['@neondatabase/serverless'] || /psycopg|asyncpg/.test(requirements)) return 'postgres';
  return 'none';
}

export function analyze(files: RepoFiles, name: string): Analysis {
  const pkg = readPackage(files);
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const scripts = pkg?.scripts ?? {};
  const python = detectPython(files);

  let stack: Stack = 'unknown';
  if (files.has('Dockerfile')) stack = 'dockerfile';
  else if (deps.next) stack = 'nextjs';
  else if (deps.vite && !pkg?.dependencies?.express && !pkg?.dependencies?.fastify && !pkg?.dependencies?.hono) stack = 'vite';
  else if (pkg && (scripts.start || pkg.main)) stack = 'node';
  else if (python) stack = python.stack;
  else if (files.has('index.html')) stack = 'static';

  const packageManager: PackageManager = files.has('pnpm-lock.yaml') ? 'pnpm' : files.has('yarn.lock') ? 'yarn' : files.has('bun.lock') || files.has('bun.lockb') ? 'bun' : 'npm';
  const envVars = collectEnvVars(files);
  const isClientBuild = stack === 'vite' || stack === 'nextjs';
  const { findings, passed } = checkCode(files, envVars, isClientBuild);
  const database = detectDatabase(pkg, files);

  let port = stack === 'nextjs' ? 3000 : 8080;
  if (stack === 'dockerfile') port = Number(/^EXPOSE\s+(\d+)/m.exec(files.get('Dockerfile') ?? '')?.[1] ?? 8080);

  if (stack === 'dockerfile' && !/^USER\s+(?!root)/m.test(files.get('Dockerfile') ?? '')) {
    findings.push({ id: 'docker-root', severity: 'medium', title: 'Your Dockerfile runs as root', why: 'If the app gets hacked, the attacker has more power inside the container.', fix: 'Add a USER line with a non-root user.' });
  }
  if (database === 'sqlite') {
    findings.push({ id: 'sqlite-data', severity: 'info', title: 'Your data lives in a SQLite file', why: 'It has to sit on a volume or it disappears when the container restarts.', fix: 'Mount a volume for it, or move to Postgres.' });
  }

  const dependencies: Analysis['dependencies'] = [];
  const lock = files.get('package-lock.json');
  if (lock && pkg) {
    try {
      const parsed = JSON.parse(lock) as { packages?: Record<string, { version?: string }> };
      for (const dep of Object.keys(pkg.dependencies ?? {})) {
        const version = parsed.packages?.[`node_modules/${dep}`]?.version;
        if (version) dependencies.push({ name: dep, version });
      }
    } catch {
      /* a broken lockfile just means no dependency check */
    }
  }

  return {
    name: (pkg?.name?.replace(/^@[\w-]+\//, '') ?? name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'app',
    stack,
    stackLabel: STACK_LABEL[stack],
    packageManager,
    port,
    startCommand: scripts.start ? 'start' : undefined,
    pythonEntry: python?.entry,
    outputDir: /outDir:\s*['"]([^'"]+)['"]/.exec(files.get('vite.config.ts') ?? files.get('vite.config.js') ?? '')?.[1] ?? 'dist',
    hasBuildScript: Boolean(scripts.build),
    database,
    needsPostgres: database === 'postgres',
    envVars,
    publicEnvVars: envVars.filter((v) => /^(VITE_|NEXT_PUBLIC_)/.test(v)),
    findings,
    passed,
    fileCount: files.size,
    dependencies,
  };
}

// Known-vulnerability lookup against the public OSV database. Failure only skips this check.
export async function checkDependencies(analysis: Analysis): Promise<void> {
  if (!analysis.dependencies.length) return;
  const queries = analysis.dependencies.map((d) => ({ package: { name: d.name, ecosystem: 'npm' }, version: d.version }));
  try {
    const res = await fetch('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { results: { vulns?: { id: string }[] }[] };
    const affected = analysis.dependencies.flatMap((dep, i) => {
      const vulns = data.results[i]?.vulns ?? [];
      return vulns.length ? [{ ...dep, count: vulns.length }] : [];
    });
    if (affected.length) {
      analysis.findings.push({
        id: 'vulnerable-deps', severity: 'high',
        title: `${affected.length} package${affected.length > 1 ? 's have' : ' has'} known security holes`,
        why: 'These are published bugs with public write-ups, so attackers already know about them.',
        fix: 'Update these packages to their latest versions.',
        evidence: affected.map((a) => `${a.name}@${a.version} (${a.count})`).join(', '),
      });
    } else analysis.passed.push(`No known holes in ${analysis.dependencies.length} direct packages`);
  } catch {
    /* OSV unreachable */
  }
}
