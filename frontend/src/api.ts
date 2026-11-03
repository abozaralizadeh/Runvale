// One place to change the name, because "Airchitect" is only a working name.
export const BRAND = 'Airchitect';

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
  grade: string;
  score: number;
  platform: { host?: string; framework?: string; backend?: string };
  tls: { valid: boolean; issuer?: string; daysLeft?: number; protocol?: string } | null;
  findings: Finding[];
  passed: string[];
  stats: { scripts: number; bytes: number; thirdPartyScripts: number };
  owner: { verified: boolean; token: string; checksRun: string[] };
  fixPrompt: string;
}

export interface QuoteOption {
  label: string;
  providerId: string;
  provider: string;
  plan: string;
  specs: string;
  region: string;
  hq: string;
  monthly: { compute: number; egress: number; backups: number; total: number };
  overBudgetBy: number;
  deploy: 'api' | 'paste';
  url: string;
  reasons: string[];
  warning?: string;
}

export interface Quote {
  need: { vcpu: number; ramGb: number; why: string };
  options: QuoteOption[];
  yearlySaving?: number;
  asOf: string;
  note: string;
}

export interface IndexRow {
  provider: string;
  plan: string;
  vcpu: number;
  ramGb: number;
  monthlyEur: number;
  egressPerTbEur: number;
  includedTb: number | null;
  hq: string;
  euHq: boolean;
  url: string;
}

export interface CloudIndex {
  asOf: string;
  source: string;
  note: string;
  rows: IndexRow[];
}

export interface Analysis {
  name: string;
  stack: string;
  stackLabel: string;
  database: string;
  needsPostgres: boolean;
  envVars: string[];
  findings: Finding[];
  passed: string[];
  fileCount: number;
}

export interface RescueResult {
  analysis: Analysis;
  quote: Quote;
  deployable: boolean;
  kit: Record<string, string>;
  repoUrl?: string;
}

export interface HetznerOption {
  name: string;
  vcpu: number;
  ramGb: number;
  diskGb: number;
  location: string;
  monthlyNet: number;
  available: boolean | null;
}

export interface DeployedServer {
  id: number;
  name: string;
  status: string;
  ip?: string;
  siteUrl?: string;
}

export interface Watch {
  id: string;
  url: string;
  label: string;
  hasNotify: boolean;
  status: string;
  statusCode: number | null;
  responseMs: number | null;
  uptime: number | null;
  tlsDays: number | null;
  grade: string | null;
  score: number | null;
  lastCheckAt: string | null;
  events: { at: string; kind: string; message: string }[];
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new Error("We can't reach the server. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong. Try again.');
  return data;
}

const post = <T,>(path: string, body: unknown, headers: Record<string, string> = {}) =>
  call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

function randomKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
}

let memoryKey: string | undefined;

export function workspaceKey(): string {
  try {
    const stored = localStorage.getItem('workspace');
    if (stored) return stored;
    const key = memoryKey ?? randomKey();
    localStorage.setItem('workspace', key);
    return key;
  } catch {
    memoryKey ??= randomKey();
    return memoryKey;
  }
}

export function setWorkspaceKey(key: string) {
  memoryKey = key;
  try {
    localStorage.setItem('workspace', key);
  } catch {
    /* the in-memory copy still works for this visit */
  }
}

const workspaceHeader = () => ({ 'x-workspace': workspaceKey() });

export const api = {
  scan: (url: string) => post<ScanReport>('/scan', { url }),
  quote: (input: object) => post<Quote>('/quote', input),
  index: () => call<CloudIndex>('/index'),
  rescue: (input: object) => post<RescueResult>('/rescue', input),
  preflight: (token: string) => post<{ options: HetznerOption[] }>('/deploy/hetzner/preflight', { token }),
  deploy: (input: object) => post<DeployedServer>('/deploy/hetzner', input),
  watches: () => call<Watch[]>('/watches', { headers: workspaceHeader() }),
  addWatch: (input: object) => post<Watch>('/watches', input, workspaceHeader()),
  removeWatch: (id: string) => call<{ ok: boolean }>(`/watches/${id}`, { method: 'DELETE', headers: workspaceHeader() }),
};
