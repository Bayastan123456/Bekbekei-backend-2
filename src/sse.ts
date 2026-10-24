import type { ServerResponse } from 'node:http';

// Disconnect a slow consumer instead of accumulating an unbounded output queue.
// The client reconnects using Last-Event-ID and replays persisted events.
export function writeSse(res: ServerResponse, data: string): boolean {
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(data)) return true;
  res.destroy();
  return false;
}
