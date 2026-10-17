import type { CourierShift } from '../models.js';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, type Database } from '../db.js';
import { assert, page } from '../core.js';
import { authentication, roles } from './auth.js';
export function shiftRoutes(db: Database) {
  const r = Router();
  r.use(authentication(db), roles('COURIER'));
  r.post('/shifts/start', async (req, res) => {
    const shift = await db.transaction(async tx => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [req.actor.id]);
      const existing = await one<CourierShift>(
        tx,
        'SELECT * FROM courier_shifts WHERE courier_id=$1 AND ended_at IS NULL',
        [req.actor.id],
      );
      return (
        existing ??
        (await one(tx, 'INSERT INTO courier_shifts(id,courier_id) VALUES($1,$2) RETURNING *', [
          randomUUID(),
          req.actor.id,
        ]))
      );
    });
    res.json({ data: shift });
  });
  r.post('/shifts/end', async (req, res) => {
    await db.transaction(async tx => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [req.actor.id]);
      assert(
        !(await one(
          tx,
          "SELECT 1 FROM delivery_tasks dt JOIN orders o ON o.id=dt.order_id WHERE dt.courier_id=$1 AND o.status NOT IN ('DELIVERED','CANCELLED','RETURNED')",
          [req.actor.id],
        )),
        409,
        'ACTIVE_DELIVERY',
        'Завершите текущий заказ',
      );
      await tx.query('UPDATE courier_shifts SET ended_at=now() WHERE courier_id=$1 AND ended_at IS NULL', [
        req.actor.id,
      ]);
    });
    res.status(204).end();
  });
  r.get('/statistics', async (req, res) => {
    const period = z.enum(['today', 'week', 'month']).parse(req.query.period ?? 'today');
    const day = period === 'today' ? 'day' : period;
    const stats = await one(
      db,
      `SELECT count(*)::int orders,COALESCE(sum(amount),0)::int earnings,COALESCE(avg(amount),0)::int average_earning FROM courier_earnings WHERE courier_id=$1 AND created_at>=date_trunc($2,now() AT TIME ZONE 'Asia/Bishkek') AT TIME ZONE 'Asia/Bishkek'`,
      [req.actor.id, day],
    );
    const rating = await one(
      db,
      'SELECT avg(score)::float rating,count(*)::int ratings FROM ratings WHERE courier_id=$1',
      [req.actor.id],
    );
    res.json({
      data: {
        ...stats,
        ...rating,
        currency: 'KGS',
        shift: await one<CourierShift>(db, 'SELECT * FROM courier_shifts WHERE courier_id=$1 AND ended_at IS NULL', [
          req.actor.id,
        ]),
      },
    });
  });
  r.get('/balance', async (req, res) => {
    const earned = await one<{ s: number }>(
      db,
      'SELECT COALESCE(sum(amount),0)::int s FROM courier_earnings WHERE courier_id=$1',
      [req.actor.id],
    );
    const paid = await one<{ s: number }>(
      db,
      'SELECT COALESCE(sum(amount),0)::int s FROM courier_payouts WHERE courier_id=$1',
      [req.actor.id],
    );
    res.json({
      data: { earned: earned!.s, paid: paid!.s, balance: earned!.s - paid!.s, currency: 'KGS' },
    });
  });
  r.get('/history', async (req, res) => {
    const p = page(req.query);
    res.json({
      data: (
        await db.query(
          `SELECT o.id,o.number,o.status,o.address_snapshot,dt.completed_at,ce.amount earning,r.score FROM delivery_tasks dt JOIN orders o ON o.id=dt.order_id LEFT JOIN courier_earnings ce ON ce.order_id=o.id LEFT JOIN ratings r ON r.order_id=o.id WHERE dt.courier_id=$1 AND o.status IN ('DELIVERED','RETURNED','CANCELLED') ORDER BY o.updated_at DESC LIMIT $2 OFFSET $3`,
          [req.actor.id, p.limit, p.offset],
        )
      ).rows,
    });
  });
  return r;
}
