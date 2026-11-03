import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

// The product name, in one place.
export const BRAND = process.env.BRAND_NAME ?? 'Runvale';

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 8790),
  dataDir: process.env.DATA_DIR ?? path.join(root, '..', 'data'),
  logDir: process.env.LOG_DIR ?? path.join(root, '..', 'logs'),
  publicDir: process.env.PUBLIC_DIR ?? path.join(root, '..', 'frontend', 'dist'),
  trustProxy: process.env.TRUST_PROXY === '1',
  // Only for tests and local runs. The public server must never reach private addresses.
  allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === '1',
  hetznerApi: process.env.HETZNER_API ?? 'https://api.hetzner.cloud/v1',
  watchIntervalMs: Number(process.env.WATCH_INTERVAL_MS ?? 5 * 60_000),
  rescanIntervalMs: Number(process.env.RESCAN_INTERVAL_MS ?? 24 * 60 * 60_000),
};
