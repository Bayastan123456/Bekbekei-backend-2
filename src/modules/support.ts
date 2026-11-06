import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, type Database } from '../db.js';
import { assert, event, page, uuid } from '../core.js';
import { authentication } from './auth.js';
import { accessOrder } from '../services/orders.js';
export function supportRoutes(db: Database) {
  const r = Router();
  r.use(authentication(db));
  r.get('/threads', async (req, res) => {
    const p = page(req.query);
    res.json({
      data: (
        await db.query(
          'SELECT * FROM support_threads WHERE ($1 OR user_id=$2) ORDER BY created_at DESC LIMIT $3 OFFSET $4',
          [req.actor.role === 'ADMIN', req.actor.id, p.limit, p.offset],
        )
      ).rows,
    });
  });
  r.get('/threads/:id', async (req, res) => {
    const thread = await one(db, 'SELECT * FROM support_threads WHERE id=$1 AND ($2 OR user_id=$3)', [
      uuid.parse(req.params.id),
      req.actor.role === 'ADMIN',
      req.actor.id,
    ]);
    assert(thread, 404, 'NOT_FOUND', 'Обращение не найдено');
    res.json({ data: thread });
  });
  r.post('/threads', async (req, res) => {
    const b = z
      .object({ orderId: uuid.optional(), message: z.string().trim().min(1).max(4000) })
      .strict()
      .parse(req.body);
    if (b.orderId) await accessOrder(db, b.orderId, req.actor);
    const id = randomUUID();
    await db.transaction(async tx => {
      await tx.query('INSERT INTO support_threads(id,user_id,order_id) VALUES($1,$2,$3)', [
        id,
        req.actor.id,
        b.orderId ?? null,
      ]);
      await tx.query('INSERT INTO support_messages(id,thread_id,author_id,body) VALUES($1,$2,$3,$4)', [
        randomUUID(),
        id,
        req.actor.id,
        b.message,
      ]);
      await event(tx, 'support.opened', { threadId: id }, null, null, 'ADMIN');
      await event(tx, 'support.status', { threadId: id, status: 'OPEN' }, req.actor.id);
    });
    res.status(201).json({ data: { id } });
  });
  r.get('/threads/:id/messages', async (req, res) => {
    const id = uuid.parse(req.params.id),
      p = page(req.query),
      thread = await one(db, 'SELECT * FROM support_threads WHERE id=$1 AND ($2 OR user_id=$3)', [
        id,
        req.actor.role === 'ADMIN',
        req.actor.id,
      ]);
    assert(thread, 404, 'NOT_FOUND', 'Обращение не найдено');
    const q = z
      .object({
        latest: z.enum(['true']).optional(),
        before: uuid.optional(),
        after: uuid.optional(),
      })
      .parse(req.query);
    assert(!(q.before && q.after), 422, 'INVALID_CURSOR', 'Выберите before или after');
    const cursor = q.before ?? q.after;
    const cursorMode = !!(q.latest || cursor);
    assert(!cursorMode || req.query.offset === undefined, 422, 'INVALID_CURSOR', 'Курсор несовместим с offset');
    if (cursor)
      assert(
        await one(db, 'SELECT id FROM support_messages WHERE id=$1 AND thread_id=$2', [cursor, id]),
        422,
        'INVALID_CURSOR',
        'Курсор не найден в обращении',
      );
    const descending = cursorMode && !q.after;
    const rows = (
      await db.query<{ id: string }>(
        `SELECT id,author_id,body,created_at,client_message_id FROM support_messages WHERE thread_id=$1
       ${cursor ? `AND (created_at,id) ${q.before ? '<' : '>'} (SELECT created_at,id FROM support_messages WHERE id=$4 AND thread_id=$1)` : ''}
       ORDER BY created_at ${descending ? 'DESC' : 'ASC'},id ${descending ? 'DESC' : 'ASC'} LIMIT $2 OFFSET $3`,
        [id, p.limit + 1, cursorMode ? 0 : p.offset, ...(cursor ? [cursor] : [])],
      )
    ).rows;
    const hasMore = rows.length > p.limit;
    const data = rows.slice(0, p.limit);
    if (descending) data.reverse();
    res.json({ data, meta: { hasMore, before: data[0]?.id ?? null, after: data.at(-1)?.id ?? null } });
  });
  r.post('/threads/:id/messages', async (req, res) => {
    const id = uuid.parse(req.params.id),
      b = z
        .object({ message: z.string().trim().min(1).max(4000), clientMessageId: uuid.optional() })
        .strict()
        .parse(req.body);
    const message = await db.transaction(async tx => {
      const thread = await one<{ id: string; user_id: string; status: 'OPEN' | 'CLOSED' }>(
        tx,
        'SELECT * FROM support_threads WHERE id=$1 AND ($2 OR user_id=$3) FOR UPDATE',
        [id, req.actor.role === 'ADMIN', req.actor.id],
      );
      assert(thread, 404, 'NOT_FOUND', 'Обращение не найдено');
      if (b.clientMessageId) {
        const existing = await one(
          tx,
          'SELECT * FROM support_messages WHERE thread_id=$1 AND author_id=$2 AND client_message_id=$3',
          [id, req.actor.id, b.clientMessageId],
        );
        if (existing) {
          assert(existing.body === b.message, 409, 'IDEMPOTENCY_CONFLICT', 'Ключ использован для другого сообщения');
          return existing;
        }
      }
      assert(thread.status === 'OPEN', 409, 'THREAD_CLOSED', 'Обращение закрыто');
      const m = await one(
        tx,
        'INSERT INTO support_messages(id,thread_id,author_id,body,client_message_id,created_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()) RETURNING *',
        [randomUUID(), id, req.actor.id, b.message, b.clientMessageId ?? null],
      );
      await event(tx, 'support.message', { threadId: id, messageId: m!.id }, thread.user_id);
      await event(tx, 'support.message', { threadId: id, messageId: m!.id }, null, null, 'ADMIN');
      return m;
    });
    res.status(201).json({ data: message });
  });
  r.patch('/threads/:id', async (req, res) => {
    assert(req.actor.role === 'ADMIN', 403, 'FORBIDDEN', 'Требуется администратор');
    const b = z
      .object({ status: z.enum(['OPEN', 'CLOSED']) })
      .strict()
      .parse(req.body);
    const thread = await db.transaction(async tx => {
      const id = uuid.parse(req.params.id);
      const previous = await one(tx, 'SELECT * FROM support_threads WHERE id=$1 FOR UPDATE', [id]);
      assert(previous, 404, 'NOT_FOUND', 'Обращение не найдено');
      if (previous.status === b.status) return previous;
      const updated = await one(tx, 'UPDATE support_threads SET status=$2,updated_at=now() WHERE id=$1 RETURNING *', [
        id,
        b.status,
      ]);
      await event(tx, 'support.status', { threadId: id, status: b.status }, previous.user_id as string);
      await event(tx, 'support.status', { threadId: id, status: b.status }, null, null, 'ADMIN');
      return updated;
    });
    res.json({ data: thread });
  });
  return r;
}
