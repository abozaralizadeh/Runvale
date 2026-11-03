import { buildApp } from './app.js';
import { config } from './config.js';
import { startWatcher } from './watch.js';

const app = await buildApp();
await app.listen({ host: config.host, port: config.port });
startWatcher();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}
