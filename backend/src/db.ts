import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'runvale.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS watches (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    url TEXT NOT NULL,
    label TEXT NOT NULL,
    notify_url TEXT,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    status_code INTEGER,
    response_ms INTEGER,
    checks_total INTEGER NOT NULL DEFAULT 0,
    checks_ok INTEGER NOT NULL DEFAULT 0,
    tls_days INTEGER,
    grade TEXT,
    score INTEGER,
    last_check_at TEXT,
    last_scan_at TEXT
  );
  CREATE INDEX IF NOT EXISTS watches_workspace ON watches (workspace);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watch_id TEXT NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_watch ON events (watch_id, id);
`);
