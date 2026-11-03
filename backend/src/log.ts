import fs from 'node:fs';
import pino from 'pino';
import { createStream } from 'rotating-file-stream';
import { config } from './config.js';

fs.mkdirSync(config.logDir, { recursive: true });

// stdout goes to journalctl. The files stay small (3 x 5 MB) so they're easy to copy off the VM.
const file = createStream('airchitect.log', { path: config.logDir, size: '5M', maxFiles: 3 });

export const logger = pino(
  { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.headers["x-workspace"]'] },
  pino.multistream([{ stream: process.stdout }, { stream: file }]),
);
