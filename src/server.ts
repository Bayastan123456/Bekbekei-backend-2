import { Lifecycle, shutdownServer } from './lifecycle.js';
import 'dotenv/config';
import { createApp } from './app.js';
import { postgres } from './db.js';
import { config, assert } from './core.js';
import { startWorker } from './worker.js';
const cfg = config();
assert(process.env.DATABASE_URL, 500, 'CONFIG', 'Задайте DATABASE_URL');
const db = postgres(process.env.DATABASE_URL);
await db.query('SELECT 1');
const lifecycle = new Lifecycle();
const server = createApp(db, cfg, lifecycle).listen(
  Number(process.env.PORT ?? 3000),
  process.env.HOST ?? '127.0.0.1',
  () => cfg.logger({ type: 'server.started', port: Number(process.env.PORT ?? 3000), testMode: true }),
);
const stopWorker = startWorker(db, cfg);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  cfg.logger({ type: 'server.stopping' });
  try {
    await shutdownServer(server, lifecycle, stopWorker, db, () => {
      cfg.logger({ type: 'server.shutdown_timeout', level: 'error' });
      process.exit(1);
    });
    cfg.logger({ type: 'server.stopped' });
    process.exit(0);
  } catch (error) {
    cfg.logger({ type: 'server.shutdown_error', level: 'error', error });
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
