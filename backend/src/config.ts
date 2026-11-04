import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

// "1" or "true" trusts any proxy. Anything else, like "127.0.0.1", is the list of proxies to trust.
function trustProxy(value = ''): boolean | string {
  if (value === '1' || value === 'true') return true;
  if (value === '' || value === '0' || value === 'false') return false;
  return value;
}

// "/runvale/" or "/runvale" becomes "/runvale". Empty means the app sits at the root.
function basePath(value = ''): string {
  const trimmed = value.trim().replace(/^\/*/, '/').replace(/\/+$/, '');
  return trimmed === '/' ? '' : trimmed;
}

// The product name, in one place.
export const BRAND = process.env.BRAND_NAME ?? 'Runvale';

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 8790),
  dataDir: process.env.DATA_DIR ?? path.join(root, '..', 'data'),
  logDir: process.env.LOG_DIR ?? path.join(root, '..', 'logs'),
  publicDir: process.env.PUBLIC_DIR ?? path.join(root, '..', 'frontend', 'dist'),
  trustProxy: trustProxy(process.env.TRUST_PROXY),
  // Set when a proxy serves the app under a path, like /runvale/. The app works with or without the proxy stripping it.
  basePath: basePath(process.env.BASE_PATH),
  // Only for tests and local runs. The public server must never reach private addresses.
  allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === '1',
  // Extra hosts and IPs the scanner must never reach, such as the server's own public name and IP.
  blockedTargets: `${process.env.SCAN_BLOCKLIST ?? ''},${process.env.SELF_ADDRESSES ?? ''}`.split(/[\s,]+/).filter(Boolean),
  scanDeadlineMs: num('SCAN_DEADLINE_MS', 40_000),
  // Fair-use caps per day (UTC). They reset at midnight and when the service restarts.
  scansPerIpDaily: num('SCANS_PER_IP_DAILY', 50),
  scansDaily: num('SCANS_DAILY', 1_000),
  rescuesPerIpDaily: num('RESCUES_PER_IP_DAILY', 20),
  rescuesDaily: num('RESCUES_DAILY', 300),
  watchAddsPerIpDaily: num('WATCH_ADDS_PER_IP_DAILY', 20),
  maxWatches: num('MAX_WATCHES', 500),
  hetznerApi: process.env.HETZNER_API ?? 'https://api.hetzner.cloud/v1',
  watchIntervalMs: num('WATCH_INTERVAL_MS', 5 * 60_000),
  rescanIntervalMs: num('RESCAN_INTERVAL_MS', 24 * 60 * 60_000),
};
