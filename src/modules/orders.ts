import type { Cart, Order } from '../models.js';
import { Router } from 'express';
import { z } from 'zod';
import { one, type Database } from '../db.js';
import { assert, money, page, uuid } from '../core.js';
import { authentication, roles } from './auth.js';
import { checkoutSchema, idempotencyKey } from '../schemas/orders.js';
import { quote, orderDetail, accessOrder, cancelOrder, createOrder } from '../services/orders.js';
export function orderRoutes(db: Database, paymentProvider: string) {
  const r = Router();
  r.use((req, _res, next) =>
    req.path === '/cart' ||
    req.path.startsWith('/cart/') ||
    req.path === '/checkout/quote' ||
    req.path === '/orders' ||
    req.path.startsWith('/orders/')
      ? next()
      : next('router'),
  );
  r.use(authentication(db), roles('CUSTOMER'));
  r.get('/cart', async (req, res) => {
    const cart = await one<Cart>(db, 'SELECT * FROM carts WHERE user_id=$1', [req.actor.id]);
    const items = cart
      ? (
          await db.query<{ price: number; quantity: number }>(
            'SELECT ci.*,p.name,p.unit,sp.price,sp.stock-sp.reserved available FROM cart_items ci JOIN products p ON p.id=ci.product_id JOIN store_products sp ON sp.product_id=p.id AND sp.store_id=$2 WHERE ci.user_id=$1 ORDER BY ci.product_id',
            [req.actor.id, cart.store_id],
          )
        ).rows
      : [];
    res.json({
      data: {
        storeId: cart?.store_id ?? null,
        items,
        subtotal: items.reduce((n, i) => n + i.price * i.quantity, 0),
        currency: 'KGS',
      },
    });
  });
  r.put('/cart/items/:id', async (req, res) => {
    const productId = uuid.parse(req.params.id),
      b = z
        .object({ storeId: uuid, quantity: z.number().int().min(1).max(100) })
        .strict()
        .parse(req.body);
    await db.transaction(async tx => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [req.actor.id]);
      const cart = await one<Cart>(tx, 'SELECT * FROM carts WHERE user_id=$1', [req.actor.id]);
      const count = await one<{ count: number }>(tx, 'SELECT count(*)::int count FROM cart_items WHERE user_id=$1', [
        req.actor.id,
      ]);
      assert(
        count!.count < 100 ||
          (await one(tx, 'SELECT 1 FROM cart_items WHERE user_id=$1 AND product_id=$2', [req.actor.id, productId])),
        422,
        'CART_TOO_LARGE',
        'В корзине не больше 100 разных товаров',
      );
      assert(
        !cart ||
          cart.store_id === b.storeId ||
          !(await one(tx, 'SELECT 1 FROM cart_items WHERE user_id=$1', [req.actor.id])),
        409,
        'CART_STORE_MISMATCH',
        'Очистите корзину перед сменой магазина',
      );
      const product = await one<{ available: number }>(
        tx,
        'SELECT sp.stock-sp.reserved available FROM store_products sp JOIN products p ON p.id=sp.product_id JOIN stores s ON s.id=sp.store_id WHERE sp.store_id=$1 AND sp.product_id=$2 AND p.active AND s.active',
        [b.storeId, productId],
      );
      assert(
        product && product.available >= b.quantity,
        409,
        'INSUFFICIENT_STOCK',
        'Товар недоступен в нужном количестве',
      );
      await tx.query(
        'INSERT INTO carts(user_id,store_id) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET store_id=excluded.store_id',
        [req.actor.id, b.storeId],
      );
      await tx.query(
        'INSERT INTO cart_items(user_id,product_id,quantity) VALUES($1,$2,$3) ON CONFLICT(user_id,product_id) DO UPDATE SET quantity=excluded.quantity',
        [req.actor.id, productId, b.quantity],
      );
    });
    res.status(204).end();
  });
  r.delete('/cart/items/:id', async (req, res) => {
    await db.transaction(async tx => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [req.actor.id]);
      await tx.query('DELETE FROM cart_items WHERE user_id=$1 AND product_id=$2', [
        req.actor.id,
        uuid.parse(req.params.id),
      ]);
    });
    res.status(204).end();
  });
  r.delete('/cart', async (req, res) => {
    await db.transaction(async tx => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [req.actor.id]);
      await tx.query('DELETE FROM carts WHERE user_id=$1', [req.actor.id]);
    });
    res.status(204).end();
  });
  r.post('/checkout/quote', async (req, res) => {
    const b = checkoutSchema.parse(req.body);
    const q = await db.transaction(tx => quote(tx, req.actor.id, b));
    const { promo, pricing, ...data } = q;
    res.json({ data });
  });
  r.post('/orders', async (req, res) => {
    const { expectedTotal, ...b } = checkoutSchema.extend({ expectedTotal: money }).parse(req.body),
      key = idempotencyKey(req.headers['idempotency-key']);
    const result = await createOrder(db, req.actor.id, b, expectedTotal, key, paymentProvider);
    res.status(result.created ? 201 : 200).json({ data: result.order });
  });
  r.get('/orders', async (req, res) => {
    const p = page(req.query);
    res.json({
      data: (
        await db.query<Order>('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3', [
          req.actor.id,
          p.limit,
          p.offset,
        ])
      ).rows,
    });
  });
  r.get('/orders/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await accessOrder(db, id, req.actor);
    res.json({ data: await orderDetail(db, id) });
  });
  r.post('/orders/:id/cancel', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await db.transaction(async tx => {
      const o = await accessOrder(tx, id, req.actor, true);
      if (o.status === 'CANCELLED') return;
      await cancelOrder(tx, o, req.actor.id);
    });
    res.json({ data: await orderDetail(db, id) });
  });
  r.post('/orders/:id/repeat', async (req, res) => {
    const result = await db.transaction(async tx => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [req.actor.id]);
      const order = await accessOrder(tx, uuid.parse(req.params.id), req.actor);
      assert(
        !(await one(tx, 'SELECT 1 FROM cart_items WHERE user_id=$1', [req.actor.id])),
        409,
        'CART_NOT_EMPTY',
        'Очистите корзину перед повтором',
      );
      const store = await one(tx, 'SELECT id FROM stores WHERE id=$1 AND active', [order.store_id]);
      assert(store, 409, 'STORE_UNAVAILABLE', 'Магазин недоступен');
      await tx.query(
        'INSERT INTO carts(user_id,store_id) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET store_id=excluded.store_id',
        [req.actor.id, order.store_id],
      );
      const items = (
        await tx.query<{ product_id: string; quantity: number }>(
          `SELECT COALESCE(CASE WHEN oi.replacement_status='ACCEPTED' THEN oi.replacement_product_id END,oi.product_id) product_id,SUM(oi.quantity)::int quantity FROM order_items oi WHERE order_id=$1 AND picking_status<>'EXCLUDED' AND unit_price>0 GROUP BY 1`,
          [order.id],
        )
      ).rows;
      const unavailable = [];
      for (const i of items) {
        const p = await one<{ available: number }>(
          tx,
          'SELECT sp.price,sp.stock-sp.reserved available FROM store_products sp JOIN products p ON p.id=sp.product_id WHERE sp.store_id=$1 AND sp.product_id=$2 AND p.active',
          [order.store_id, i.product_id],
        );
        if (!p || p.available < i.quantity || i.quantity > 100) {
          unavailable.push(i.product_id);
          continue;
        }
        await tx.query('INSERT INTO cart_items(user_id,product_id,quantity) VALUES($1,$2,$3)', [
          req.actor.id,
          i.product_id,
          i.quantity,
        ]);
      }
      return { unavailable, requiresCheckout: true };
    });
    res.json({ data: result });
  });
  r.put('/orders/:id/rating', async (req, res) => {
    const b = z
      .object({ score: z.number().int().min(1).max(5), comment: z.string().max(1000).default('') })
      .strict()
      .parse(req.body);
    const o = await accessOrder(db, uuid.parse(req.params.id), req.actor);
    assert(o.status === 'DELIVERED', 409, 'NOT_DELIVERED', 'Оценка доступна после доставки');
    const task = (await one(db, 'SELECT courier_id FROM delivery_tasks WHERE order_id=$1', [o.id]))!;
    await db.query(
      'INSERT INTO ratings(order_id,user_id,courier_id,score,comment) VALUES($1,$2,$3,$4,$5) ON CONFLICT(order_id) DO UPDATE SET score=excluded.score,comment=excluded.comment',
      [o.id, req.actor.id, task.courier_id, b.score, b.comment],
    );
    res.status(204).end();
  });
  return r;
}
