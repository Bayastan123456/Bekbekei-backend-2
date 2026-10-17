import type { ServerResponse, Server } from 'node:http';
import type { Database } from './db.js';

export class Lifecycle {
  draining = false;
  private streams = new Set<ServerResponse>();
  registerStream(res: ServerResponse) {
    if (this.draining) {
      res.end();
      return;
    }
    this.streams.add(res);
    res.once('close', () => this.streams.delete(res));
  }
  drain() {
    this.draining = true;
    for (const res of this.streams) res.end();
    this.streams.clear();
  }
}

export async function shutdownServer(
  server: Server,
  lifecycle: Lifecycle,
  stopWorker: () => Promise<void>,
  db: Pick<Database, 'close'>,
  onTimeout: () => void,
  timeoutMs = 30_000,
) {
  lifecycle.drain();
  const deadline = setTimeout(() => {
    server.closeAllConnections();
    onTimeout();
  }, timeoutMs);
  try {
    const httpClosed = new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
    await Promise.all([httpClosed, stopWorker()]);
    await db.close();
  } finally {
    clearTimeout(deadline);
  }
}
