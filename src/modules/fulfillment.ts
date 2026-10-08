import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, type Database, type SQL } from '../db.js';
import { assert, event, page, uuid } from '../core.js';
import { authentication, roles, type Actor } from './auth.js';
import {
  accessOrder,
  cancelOrder,
  enqueueRefund,
  orderDetail,
  recalculate,
  releaseInventory,
  setStatus,
} from './orders.js';
export async function courierRate(tx: SQL) {
  const row = await one(tx, "SELECT value FROM settings WHERE key='courier_delivery_rate'", []);
  return row ? Number(row.value) : 8000;
}
export async function assignedStore(tx: SQL, actor: Actor, storeId: string) {
  assert(
    await one(tx, 'SELECT 1 FROM staff_stores WHERE user_id=$1 AND store_id=$2', [actor.id, storeId]),
    403,
    'STORE_FORBIDDEN',
    'Нет доступа к этому магазину',
  );
}
async function stockLock(tx: SQL, storeId: string, ids: string[]) {
  return tx.query(
    'SELECT * FROM store_products WHERE store_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id FOR UPDATE',
    [storeId, [...new Set(ids)].sort()],
  );
}
export function pickingRoutes(db: Database) {
  const r = Router();
  r.use(authentication(db), roles('PICKER'));
  r.get('/tasks', async (req, res) => {
    const p = page(req.query);
    res.json({
      data: (
        await db.query(
          `SELECT o.id,o.number,o.status,o.store_id,o.created_at,pt.picker_id,pt.claimed_at,
      (SELECT count(*)::int FROM order_items oi WHERE oi.order_id=o.id) item_count
      FROM orders o JOIN picking_tasks pt ON pt.order_id=o.id JOIN staff_stores ss ON ss.store_id=o.store_id AND ss.user_id=$1
      WHERE o.status IN ('CONFIRMED','PICKING','READY') AND (pt.picker_id IS NULL OR pt.picker_id=$1)
      ORDER BY o.created_at LIMIT $2 OFFSET $3`,
          [req.actor.id, p.limit, p.offset],
        )
      ).rows,
    });
  });
  r.post('/tasks/:id/claim', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await db.transaction(async tx => {
      const o = await one(tx, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
      assert(o, 404, 'NOT_FOUND', 'Заказ не найден');
      await assignedStore(tx, req.actor, o.store_id);
      const task = (await one(tx, 'SELECT * FROM picking_tasks WHERE order_id=$1', [id]))!;
      if (task.picker_id === req.actor.id && o.status === 'PICKING') return;
      assert(o.status === 'CONFIRMED' && !task.picker_id, 409, 'ALREADY_CLAIMED', 'Заказ уже занят или недоступен');
      await tx.query('UPDATE picking_tasks SET picker_id=$2,claimed_at=now() WHERE order_id=$1', [id, req.actor.id]);
      await setStatus(tx, o, 'PICKING', req.actor.id);
    });
    res.json({ data: await orderDetail(db, id) });
  });
  r.get('/tasks/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await accessOrder(db, id, req.actor);
    res.json({ data: await orderDetail(db, id) });
  });
  r.patch('/tasks/:id/items/:itemId', async (req, res) => {
    const id = uuid.parse(req.params.id),
      itemId = uuid.parse(req.params.itemId);
    const b = z
      .discriminatedUnion('action', [
        z.object({ action: z.literal('PICK') }),
        z.object({ action: z.literal('EXCLUDE') }),
        z.object({ action: z.literal('PROPOSE_REPLACEMENT'), productId: uuid }),
      ])
      .parse(req.body);
    await db.transaction(async tx => {
      const o = await accessOrder(tx, id, req.actor, true);
      assert(o.status === 'PICKING', 409, 'INVALID_STATE', 'Заказ не собирается');
      const i = await one(tx, 'SELECT * FROM order_items WHERE id=$1 AND order_id=$2', [itemId, id]);
      assert(i, 404, 'NOT_FOUND', 'Позиция не найдена');
      if (b.action === 'PICK' && i.picking_status === 'PICKED') return;
      if (b.action === 'EXCLUDE' && i.picking_status === 'EXCLUDED') return;
      assert(
        i.picking_status === 'PENDING' && i.replacement_status !== 'PROPOSED',
        409,
        'ITEM_ALREADY_HANDLED',
        'Позиция уже обработана или ожидает согласования',
      );
      if (b.action === 'PICK') await tx.query("UPDATE order_items SET picking_status='PICKED' WHERE id=$1", [itemId]);
      if (b.action === 'EXCLUDE') {
        await tx.query('UPDATE store_products SET reserved=reserved-$3 WHERE store_id=$1 AND product_id=$2', [
          o.store_id,
          i.product_id,
          i.reserved_quantity,
        ]);
        await tx.query("UPDATE order_items SET picking_status='EXCLUDED',reserved_quantity=0 WHERE id=$1", [itemId]);
        await recalculate(tx, o);
      }
      if (b.action === 'PROPOSE_REPLACEMENT') {
        assert(b.productId !== i.product_id, 422, 'SAME_PRODUCT', 'Выберите другой товар');
        assert(i.unit_price > 0, 422, 'GIFT_REPLACEMENT', 'Подарок можно только исключить');
        await stockLock(tx, o.store_id, [i.product_id, b.productId]);
        const replacement = await one(
          tx,
          'SELECT p.*,sp.price,sp.stock-sp.reserved available FROM products p JOIN store_products sp ON sp.product_id=p.id WHERE p.id=$1 AND sp.store_id=$2 AND p.active',
          [b.productId, o.store_id],
        );
        assert(replacement && replacement.available >= i.quantity, 409, 'INSUFFICIENT_STOCK', 'Замена недоступна');
        assert(!replacement.age_restricted, 422, 'AGE_RESTRICTED_REPLACEMENT', 'Замена на товар 18+ недоступна');
        assert(
          o.payment_method !== 'QR' || replacement.price <= i.unit_price,
          422,
          'REPLACEMENT_TOO_EXPENSIVE',
          'Для предоплаты замена должна быть не дороже',
        );
        await tx.query('UPDATE store_products SET reserved=reserved+$3 WHERE store_id=$1 AND product_id=$2', [
          o.store_id,
          b.productId,
          i.quantity,
        ]);
        await tx.query(
          "UPDATE order_items SET replacement_product_id=$2,replacement_price=$3,replacement_name=$4,replacement_status='PROPOSED' WHERE id=$1",
          [itemId, b.productId, replacement.price, JSON.stringify(replacement.name)],
        );
        await event(
          tx,
          'replacement.proposed',
          { orderId: id, itemId, productId: b.productId, price: replacement.price },
          o.user_id,
        );
      }
      await event(tx, 'picking.item', { orderId: id, itemId, action: b.action }, o.user_id);
    });
    res.json({ data: await orderDetail(db, id) });
  });
  r.post('/tasks/:id/complete', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await db.transaction(async tx => {
      const o = await accessOrder(tx, id, req.actor, true);
      if (o.status === 'READY') return;
      assert(o.status === 'PICKING', 409, 'INVALID_STATE', 'Заказ не собирается');
      const items = (await tx.query('SELECT * FROM order_items WHERE order_id=$1', [id])).rows;
      assert(
        items.every(i => i.picking_status !== 'PENDING' && i.replacement_status !== 'PROPOSED'),
        409,
        'PICKING_INCOMPLETE',
        'Обработайте все позиции и дождитесь согласования замен',
      );
      if (items.every(i => i.picking_status === 'EXCLUDED')) {
        await cancelOrder(tx, o, req.actor.id);
        return;
      }
      await tx.query('UPDATE picking_tasks SET completed_at=now() WHERE order_id=$1', [id]);
      await setStatus(tx, o, 'READY', req.actor.id);
    });
    res.json({ data: await orderDetail(db, id) });
  });
  return r;
}
export function replacementRoutes(db: Database) {
  const r = Router();
  r.use((req, _res, next) => (/^\/orders\/[^/]+\/items\/[^/]+\/replacement$/.test(req.path) ? next() : next('router')));
  r.use(authentication(db), roles('CUSTOMER'));
  r.post('/orders/:id/items/:itemId/replacement', async (req, res) => {
    const id = uuid.parse(req.params.id),
      itemId = uuid.parse(req.params.itemId),
      b = z.object({ accept: z.boolean() }).strict().parse(req.body);
    await db.transaction(async tx => {
      const o = await accessOrder(tx, id, req.actor, true);
      assert(o.status === 'PICKING', 409, 'INVALID_STATE', 'Заказ не собирается');
      const i = await one(tx, 'SELECT * FROM order_items WHERE id=$1 AND order_id=$2', [itemId, id]);
      assert(i, 404, 'NOT_FOUND', 'Позиция не найдена');
      assert(i.replacement_status === 'PROPOSED', 409, 'NO_REPLACEMENT', 'Нет предложения замены');
      await stockLock(tx, o.store_id, [i.product_id, i.replacement_product_id]);
      if (b.accept) {
        await tx.query('UPDATE store_products SET reserved=reserved-$3 WHERE store_id=$1 AND product_id=$2', [
          o.store_id,
          i.product_id,
          i.reserved_quantity,
        ]);
        await tx.query("UPDATE order_items SET replacement_status='ACCEPTED',picking_status='REPLACED' WHERE id=$1", [
          itemId,
        ]);
        await recalculate(tx, o);
      } else {
        await tx.query('UPDATE store_products SET reserved=reserved-$3 WHERE store_id=$1 AND product_id=$2', [
          o.store_id,
          i.replacement_product_id,
          i.quantity,
        ]);
        await tx.query("UPDATE order_items SET replacement_status='REJECTED' WHERE id=$1", [itemId]);
      }
      await event(tx, 'replacement.resolved', { orderId: id, itemId, accepted: b.accept }, null, o.store_id, 'PICKER');
    });
    res.json({ data: await orderDetail(db, id) });
  });
  return r;
}
async function courierTask(tx: SQL, id: string, actor: Actor) {
  const o = await accessOrder(tx, id, actor, true),
    task = (await one(tx, 'SELECT * FROM delivery_tasks WHERE order_id=$1', [id]))!;
  return { o, task };
}
export function deliveryRoutes(db: Database) {
  const r = Router();
  r.use(authentication(db), roles('COURIER'));
  r.get('/tasks', async (req, res) => {
    const p = page(req.query);
    const shift = await one(db, 'SELECT id FROM courier_shifts WHERE courier_id=$1 AND ended_at IS NULL', [
      req.actor.id,
    ]);
    if (!shift) {
      res.json({ data: [] });
      return;
    }
    res.json({
      data: (
        await db.query(
          `SELECT o.id,o.number,o.status,o.store_id,s.address pickup_address,o.total,o.payment_status,o.payment_method,dt.courier_id,
      CASE WHEN dt.courier_id=$1 THEN o.address_snapshot ELSE jsonb_build_object('street',o.address_snapshot->>'street') END address
      FROM orders o JOIN delivery_tasks dt ON dt.order_id=o.id JOIN stores s ON s.id=o.store_id JOIN staff_stores ss ON ss.store_id=o.store_id AND ss.user_id=$1
      WHERE o.status IN ('CONFIRMED','PICKING','READY','DELIVERING','RETURNING') AND (dt.courier_id IS NULL OR dt.courier_id=$1)
      ORDER BY o.created_at LIMIT $2 OFFSET $3`,
          [req.actor.id, p.limit, p.offset],
        )
      ).rows,
    });
  });
  r.post('/tasks/:id/claim', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await db.transaction(async tx => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [req.actor.id]);
      const shift = await one(tx, 'SELECT * FROM courier_shifts WHERE courier_id=$1 AND ended_at IS NULL', [
        req.actor.id,
      ]);
      assert(shift, 409, 'NOT_ON_SHIFT', 'Начните смену');
      const o = await one(tx, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
      assert(o, 404, 'NOT_FOUND', 'Заказ не найден');
      await assignedStore(tx, req.actor, o.store_id);
      const task = (await one(tx, 'SELECT * FROM delivery_tasks WHERE order_id=$1', [id]))!;
      if (task.courier_id === req.actor.id && ['CONFIRMED', 'PICKING', 'READY'].includes(o.status)) return;
      assert(
        ['CONFIRMED', 'PICKING', 'READY'].includes(o.status) && !task.courier_id,
        409,
        'ALREADY_CLAIMED',
        'Заказ уже занят или недоступен',
      );
      assert(
        !(await one(
          tx,
          "SELECT 1 FROM delivery_tasks dt JOIN orders o ON o.id=dt.order_id WHERE dt.courier_id=$1 AND o.status NOT IN ('DELIVERED','CANCELLED','RETURNED')",
          [req.actor.id],
        )),
        409,
        'ACTIVE_DELIVERY',
        'Сначала завершите текущий заказ',
      );
      await tx.query('UPDATE delivery_tasks SET courier_id=$2,claimed_at=now(),shift_id=$3 WHERE order_id=$1', [
        id,
        req.actor.id,
        shift.id,
      ]);
      await event(tx, 'courier.assigned', { orderId: id }, o.user_id);
    });
    res.json({ data: await orderDetail(db, id) });
  });
  r.get('/tasks/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await accessOrder(db, id, req.actor);
    res.json({ data: await orderDetail(db, id) });
  });
  r.post('/tasks/:id/pickup', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await db.transaction(async tx => {
      const { o } = await courierTask(tx, id, req.actor);
      if (o.status === 'DELIVERING') return;
      assert(o.status === 'READY', 409, 'NOT_READY', 'Заказ ещё не собран');
      const items = (
        await tx.query(
          "SELECT * FROM order_items WHERE order_id=$1 AND picking_status<>'EXCLUDED' ORDER BY product_id",
          [id],
        )
      ).rows;
      await stockLock(
        tx,
        o.store_id,
        items.map(i => (i.replacement_status === 'ACCEPTED' ? i.replacement_product_id : i.product_id)),
      );
      for (const i of items)
        await tx.query(
          'UPDATE store_products SET stock=stock-$3,reserved=reserved-$3 WHERE store_id=$1 AND product_id=$2',
          [o.store_id, i.replacement_status === 'ACCEPTED' ? i.replacement_product_id : i.product_id, i.quantity],
        );
      await tx.query('UPDATE order_items SET reserved_quantity=0 WHERE order_id=$1', [id]);
      await tx.query('UPDATE delivery_tasks SET picked_up_at=now() WHERE order_id=$1', [id]);
      await setStatus(tx, o, 'DELIVERING', req.actor.id);
    });
    res.json({ data: await orderDetail(db, id) });
  });
  r.post('/tasks/:id/arrive', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await db.transaction(async tx => {
      const { o } = await courierTask(tx, id, req.actor);
      assert(o.status === 'DELIVERING', 409, 'INVALID_STATE', 'Заказ не в доставке');
      await tx.query('UPDATE delivery_tasks SET arrived_at=COALESCE(arrived_at,now()) WHERE order_id=$1', [id]);
      await event(tx, 'courier.arrived', { orderId: id }, o.user_id);
    });
    res.status(204).end();
  });
  r.post('/tasks/:id/confirm-cash', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await db.transaction(async tx => {
      const { o, task } = await courierTask(tx, id, req.actor);
      assert(o.status === 'DELIVERING' && task.arrived_at, 409, 'INVALID_STATE', 'Сначала отметьте прибытие');
      assert(o.payment_method === 'CASH', 409, 'NOT_CASH', 'Заказ оплачен через QR');
      await tx.query("UPDATE orders SET payment_status='PAID' WHERE id=$1", [id]);
      await event(tx, 'payment.cash_received', { orderId: id }, o.user_id);
    });
    res.status(204).end();
  });
  r.post('/tasks/:id/complete', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await db.transaction(async tx => {
      const { o, task } = await courierTask(tx, id, req.actor);
      if (o.status === 'DELIVERED') return;
      assert(o.status === 'DELIVERING' && task.arrived_at, 409, 'INVALID_STATE', 'Сначала отметьте прибытие');
      assert(o.payment_status === 'PAID', 409, 'PAYMENT_REQUIRED', 'Подтвердите оплату');
      await tx.query('UPDATE delivery_tasks SET completed_at=now() WHERE order_id=$1', [id]);
      await tx.query(
        'INSERT INTO courier_earnings(order_id,courier_id,shift_id,amount) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [id, req.actor.id, task.shift_id, await courierRate(tx)],
      );
      await setStatus(tx, o, 'DELIVERED', req.actor.id);
    });
    res.json({ data: await orderDetail(db, id) });
  });
  r.post('/tasks/:id/report-unreachable', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await db.transaction(async tx => {
      const { o, task } = await courierTask(tx, id, req.actor);
      assert(o.status === 'DELIVERING' && task.arrived_at, 409, 'INVALID_STATE', 'Сначала отметьте прибытие');
      assert(
        o.payment_method !== 'CASH' || o.payment_status !== 'PAID',
        409,
        'CASH_ALREADY_RECEIVED',
        'После приёма наличных возврат оформляет поддержка',
      );
      if (o.waiting_until) return;
      await tx.query("UPDATE orders SET waiting_until=now()+interval '15 minutes' WHERE id=$1", [id]);
      await tx.query(
        "INSERT INTO jobs(id,kind,payload,run_at) VALUES($1,'UNREACHABLE_ORDER',$2,now()+interval '15 minutes')",
        [randomUUID(), JSON.stringify({ orderId: id })],
      );
      await event(tx, 'delivery.waiting', { orderId: id, seconds: 900 }, o.user_id);
    });
    res.json({ data: await orderDetail(db, id) });
  });
  r.post('/tasks/:id/return', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await db.transaction(async tx => {
      const { o, task } = await courierTask(tx, id, req.actor);
      if (o.status === 'RETURNED') return;
      assert(
        o.status === 'RETURNING',
        409,
        'RETURN_NOT_AUTHORIZED',
        'Дождитесь завершения ожидания или решения поддержки',
      );
      await releaseInventory(tx, o, true);
      await enqueueRefund(tx, o, o.total);
      if (o.payment_status === 'PAID')
        await tx.query(
          "UPDATE orders SET payment_status=CASE WHEN total=0 THEN 'REFUNDED' ELSE 'REFUND_PENDING' END WHERE id=$1",
          [id],
        );
      await tx.query('UPDATE delivery_tasks SET completed_at=now() WHERE order_id=$1', [id]);
      await tx.query(
        'INSERT INTO courier_earnings(order_id,courier_id,shift_id,amount) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [id, req.actor.id, task.shift_id, await courierRate(tx)],
      );
      await setStatus(tx, o, 'RETURNED', req.actor.id);
    });
    res.json({ data: await orderDetail(db, id) });
  });
  return r;
}
export function shiftRoutes(db: Database) {
  const r = Router();
  r.use(authentication(db), roles('COURIER'));
  r.post('/shifts/start', async (req, res) => {
    const shift = await db.transaction(async tx => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [req.actor.id]);
      const existing = await one(tx, 'SELECT * FROM courier_shifts WHERE courier_id=$1 AND ended_at IS NULL', [
        req.actor.id,
      ]);
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
        shift: await one(db, 'SELECT * FROM courier_shifts WHERE courier_id=$1 AND ended_at IS NULL', [req.actor.id]),
      },
    });
  });
  r.get('/balance', async (req, res) => {
    const earned = await one(db, 'SELECT COALESCE(sum(amount),0)::int s FROM courier_earnings WHERE courier_id=$1', [
      req.actor.id,
    ]);
    const paid = await one(db, 'SELECT COALESCE(sum(amount),0)::int s FROM courier_payouts WHERE courier_id=$1', [
      req.actor.id,
    ]);
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
