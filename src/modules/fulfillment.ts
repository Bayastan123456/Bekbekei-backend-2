import { pickingActionSchema } from '../schemas/fulfillment.js';
import { assignedStore, stockLock, courierRate, handlePickingItem } from '../services/fulfillment.js';
import type { CourierShift, DeliveryTask, Order, OrderItem, PickingTask } from '../models.js';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, type Database, type SQL } from '../db.js';
import { assert, event, page, uuid } from '../core.js';
import { authentication, roles, type Actor } from './auth.js';
import {
  inventoryProductId,
  accessOrder,
  cancelOrder,
  enqueueRefund,
  orderDetail,
  recalculate,
  releaseInventory,
  setStatus,
} from '../services/orders.js';
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
      const o = await one<Order>(tx, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
      assert(o, 404, 'NOT_FOUND', 'Заказ не найден');
      await assignedStore(tx, req.actor, o.store_id);
      const task = (await one<PickingTask>(tx, 'SELECT * FROM picking_tasks WHERE order_id=$1', [id]))!;
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
    const b = pickingActionSchema.parse(req.body);
    await handlePickingItem(db, req.actor, id, itemId, b);
    res.json({ data: await orderDetail(db, id) });
  });
  r.post('/tasks/:id/complete', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await db.transaction(async tx => {
      const o = await accessOrder(tx, id, req.actor, true);
      if (o.status === 'READY') return;
      assert(o.status === 'PICKING', 409, 'INVALID_STATE', 'Заказ не собирается');
      const items = (await tx.query<OrderItem>('SELECT * FROM order_items WHERE order_id=$1', [id])).rows;
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
      const i = await one<OrderItem>(tx, 'SELECT * FROM order_items WHERE id=$1 AND order_id=$2', [itemId, id]);
      assert(i, 404, 'NOT_FOUND', 'Позиция не найдена');
      assert(
        i.replacement_status === 'PROPOSED' && i.replacement_product_id,
        409,
        'NO_REPLACEMENT',
        'Нет предложения замены',
      );
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
    task = (await one<DeliveryTask>(tx, 'SELECT * FROM delivery_tasks WHERE order_id=$1', [id]))!;
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
      const shift = await one<CourierShift>(
        tx,
        'SELECT * FROM courier_shifts WHERE courier_id=$1 AND ended_at IS NULL',
        [req.actor.id],
      );
      assert(shift, 409, 'NOT_ON_SHIFT', 'Начните смену');
      const o = await one<Order>(tx, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
      assert(o, 404, 'NOT_FOUND', 'Заказ не найден');
      await assignedStore(tx, req.actor, o.store_id);
      const task = (await one<DeliveryTask>(tx, 'SELECT * FROM delivery_tasks WHERE order_id=$1', [id]))!;
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
        await tx.query<OrderItem>(
          "SELECT * FROM order_items WHERE order_id=$1 AND picking_status<>'EXCLUDED' ORDER BY product_id",
          [id],
        )
      ).rows;
      await stockLock(
        tx,
        o.store_id,
        items.map(i => inventoryProductId(i)),
      );
      for (const i of items)
        await tx.query(
          'UPDATE store_products SET stock=stock-$3,reserved=reserved-$3 WHERE store_id=$1 AND product_id=$2',
          [o.store_id, inventoryProductId(i), i.quantity],
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
