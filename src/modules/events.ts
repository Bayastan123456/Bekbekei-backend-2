import { writeSse } from '../sse.js';
import type { Lifecycle } from '../lifecycle.js';
import { Router } from 'express';
import { z } from 'zod';
import { one, type Database } from '../db.js';
import { assert } from '../core.js';
import { authentication } from './auth.js';
export function eventRoutes(db: Database, lifecycle?: Lifecycle) {
  const r = Router(),
    connections = new Map<string, number>();
  r.use(authentication(db));
  r.get('/', (req, res) => {
    assert(!lifecycle?.draining, 503, 'SHUTTING_DOWN', 'Сервис завершает работу');
    let after = z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .parse(req.headers['last-event-id'] ?? req.query.after ?? 0);
    const count = connections.get(req.actor.id) ?? 0;
    assert(count < 3, 429, 'TOO_MANY_STREAMS', 'Не больше трёх потоков на пользователя');
    connections.set(req.actor.id, count + 1);
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    lifecycle?.registerStream(res);
    let busy = false,
      closed = false,
      checkReplay = after > 0;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      const remaining = (connections.get(req.actor.id) ?? 1) - 1;
      if (remaining > 0) connections.set(req.actor.id, remaining);
      else connections.delete(req.actor.id);
    };
    const tick = async () => {
      if (busy || closed) return;
      busy = true;
      try {
        const session = await one(
          db,
          'SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND revoked_at IS NULL AND access_expires_at>now() AND u.active',
          [req.actor.session_id],
        );
        if (closed || res.writableEnded) return;
        if (!session) {
          cleanup();
          res.end();
          return;
        }
        if (checkReplay) {
          checkReplay = false;
          const retained = await one<{ oldest: string | null }>(db, 'SELECT min(id)::text oldest FROM events');
          if (closed || res.writableEnded) return;
          if (!retained?.oldest || after < Number(retained.oldest) - 1) {
            if (!writeSse(res, 'event: stream.reset\ndata: {"reason":"HISTORY_EXPIRED"}\n\n')) {
              cleanup();
              return;
            }
          }
        }
        const events = (
          await db.query(
            `SELECT id,type,payload FROM events e WHERE e.id>$1 AND
          (e.user_id=$2 OR (e.role=$3 AND (e.store_id IS NULL OR EXISTS(SELECT 1 FROM staff_stores ss WHERE ss.user_id=$2 AND ss.store_id=e.store_id))))
          ORDER BY e.id LIMIT 100`,
            [after, req.actor.id, req.actor.role],
          )
        ).rows;
        if (closed || res.writableEnded) return;
        for (const e of events) {
          after = Number(e.id);
          if (!writeSse(res, `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.payload)}\n\n`)) {
            cleanup();
            return;
          }
        }
        if (!events.length && !writeSse(res, ': heartbeat\n\n')) cleanup();
      } catch {
        cleanup();
        res.end();
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void tick(), 2000);
    timer.unref();
    res.on('close', cleanup);
    void tick();
  });
  return r;
}
