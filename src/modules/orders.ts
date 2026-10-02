import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, type Database, type SQL, type Row } from '../db.js';
import { assert, event, money, page, sha, uuid } from '../core.js';
import { authentication, roles, type Actor } from './auth.js';
import { distanceKm, isStoreOpen } from './catalog.js';
export const checkoutSchema = z
  .object({
    addressId: uuid,
    paymentMethod: z.enum(['CASH', 'QR']),
    email: z.email().max(254).optional(),
    courierComment: z.string().max(1000).default(''),
    cashChangeFrom: money.optional(),
    promoCode: z.string().min(1).max(40).optional(),
    ageConfirmed: z.boolean().default(false),
  })
  .strict();
export type Checkout = z.infer<typeof checkoutSchema>;
export function idempotencyKey(raw: unknown) {
  return z
    .string()
    .min(8)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .parse(raw);
}
export async function quote(tx: SQL, userId: string, b: Checkout, lock = false) {
  const cart = await one(tx, 'SELECT * FROM carts WHERE user_id=$1', [userId]);
  assert(cart, 400, 'EMPTY_CART', 'Корзина пуста');
  const store = await one(tx, 'SELECT * FROM stores WHERE id=$1 AND active', [cart.store_id]);
  assert(store, 400, 'STORE_UNAVAILABLE', 'Магазин недоступен');
  assert(isStoreOpen(store), 409, 'STORE_CLOSED', 'Магазин закрыт');
  const address = await one(tx, 'SELECT * FROM addresses WHERE id=$1 AND user_id=$2', [b.addressId, userId]);
  assert(address, 404, 'ADDRESS_NOT_FOUND', 'Адрес не найден');
  assert(
    distanceKm(store, address) <= Number(store.radius_km),
    422,
    'OUTSIDE_DELIVERY_ZONE',
    'Адрес вне зоны доставки',
  );
  if (lock) {
    const gift = b.promoCode
      ? await one(tx, 'SELECT gift_product_id FROM promotions WHERE code=$1', [b.promoCode])
      : null;
    await tx.query(
      `SELECT * FROM store_products WHERE store_id=$2 AND (product_id IN (SELECT product_id FROM cart_items WHERE user_id=$1) OR product_id=$3) ORDER BY product_id FOR UPDATE`,
      [userId, store.id, gift?.gift_product_id ?? null],
    );
  }
  const items = (
    await tx.query(
      `SELECT ci.product_id,ci.quantity,p.name,p.unit,p.active,p.age_restricted,sp.price,sp.stock-sp.reserved available
    FROM cart_items ci JOIN products p ON p.id=ci.product_id JOIN store_products sp ON sp.product_id=p.id AND sp.store_id=$2
    WHERE ci.user_id=$1 ORDER BY ci.product_id ${lock ? 'FOR UPDATE OF sp' : ''}`,
      [userId, store.id],
    )
  ).rows;
  assert(items.length, 400, 'EMPTY_CART', 'Корзина пуста');
  for (const item of items) {
    assert(
      item.active && item.available >= item.quantity,
      409,
      'INSUFFICIENT_STOCK',
      `Недостаточно товара: ${item.name.ru}`,
    );
    assert(
      !item.age_restricted || b.ageConfirmed,
      422,
      'AGE_CONFIRMATION_REQUIRED',
      'Подтвердите возраст для товаров 18+',
    );
  }
  const subtotal = items.reduce((n, i) => n + i.price * i.quantity, 0);
  assert(subtotal <= 100_000_000, 422, 'ORDER_TOO_LARGE', 'Стоимость заказа превышает лимит 1 000 000 сом');
  assert(subtotal >= store.minimum_order, 422, 'MINIMUM_ORDER', `Минимальная сумма: ${store.minimum_order / 100} сом`);
  // One first-delivery benefit per customer, including an active reservation.
  const prior = await one(
    tx,
    "SELECT id FROM orders WHERE user_id=$1 AND status NOT IN ('CANCELLED','RETURNED') LIMIT 1",
    [userId],
  );
  let fee = prior ? store.delivery_fee : 0,
    discount = 0;
  let promo: Row | undefined;
  if (b.promoCode) {
    promo = await one(
      tx,
      `SELECT * FROM promotions WHERE code=$1 AND active AND starts_at<=now() AND ends_at>now() ${lock ? 'FOR UPDATE' : ''}`,
      [b.promoCode],
    );
    assert(
      promo && promo.used < promo.usage_limit && subtotal >= promo.minimum_order,
      422,
      'INVALID_PROMO',
      'Промокод недоступен',
    );
    assert(
      !(await one(tx, 'SELECT 1 FROM promotion_redemptions WHERE code=$1 AND user_id=$2', [promo.code, userId])),
      422,
      'PROMO_ALREADY_USED',
      'Промокод уже использован',
    );
    if (promo.kind === 'PERCENT') discount = Math.floor((subtotal * Math.min(promo.value, 100)) / 100);
    if (promo.kind === 'FIXED') discount = Math.min(subtotal, promo.value);
    if (promo.kind === 'FREE_DELIVERY') fee = 0;
    if (promo.kind === 'GIFT') {
      assert(
        promo.gift_product_id && items.some(i => promo!.trigger_product_ids.includes(i.product_id)),
        422,
        'GIFT_NOT_ELIGIBLE',
        'В корзине нет товара для подарка',
      );
      const gift = await one(
        tx,
        `SELECT p.id product_id,p.name,p.unit,sp.stock-sp.reserved available FROM products p JOIN store_products sp ON sp.product_id=p.id WHERE p.id=$1 AND p.active AND sp.store_id=$2 ${lock ? 'FOR UPDATE OF sp' : ''}`,
        [promo.gift_product_id, store.id],
      );
      const purchased = items.find(i => i.product_id === promo!.gift_product_id)?.quantity ?? 0;
      assert(gift && gift.available >= purchased + 1, 409, 'GIFT_UNAVAILABLE', 'Подарок закончился');
      items.push({ ...gift, quantity: 1, price: 0, gift: true });
    }
  }
  const total = subtotal - discount + fee;
  assert(
    !b.cashChangeFrom || b.cashChangeFrom >= total,
    422,
    'INVALID_CHANGE',
    'Сумма для сдачи меньше стоимости заказа',
  );
  return {
    store,
    address,
    items,
    subtotal,
    discount,
    deliveryFee: fee,
    total,
    currency: 'KGS',
    promo,
    pricing: { kind: promo?.kind ?? null, value: promo?.value ?? 0, firstDelivery: !prior },
    etaMinutes: { min: 20, max: 25 },
    estimate: true,
  };
}
export async function orderDetail(tx: SQL, id: string) {
  const order = await one(tx, 'SELECT * FROM orders WHERE id=$1', [id]);
  assert(order, 404, 'NOT_FOUND', 'Заказ не найден');
  return {
    ...order,
    items: (await tx.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id', [id])).rows,
    history: (await tx.query('SELECT status,created_at FROM order_status_history WHERE order_id=$1 ORDER BY id', [id]))
      .rows,
    picking: await one(tx, 'SELECT * FROM picking_tasks WHERE order_id=$1', [id]),
    delivery: await one(tx, 'SELECT * FROM delivery_tasks WHERE order_id=$1', [id]),
  };
}
export async function accessOrder(tx: SQL, id: string, actor: Actor, lock = false) {
  const order = await one(tx, `SELECT * FROM orders WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  assert(order, 404, 'NOT_FOUND', 'Заказ не найден');
  const allowed =
    actor.role === 'ADMIN' ||
    (actor.role === 'CUSTOMER' && order.user_id === actor.id) ||
    (actor.role === 'PICKER' &&
      !!(await one(tx, 'SELECT 1 FROM picking_tasks WHERE order_id=$1 AND picker_id=$2', [id, actor.id]))) ||
    (actor.role === 'COURIER' &&
      !!(await one(tx, 'SELECT 1 FROM delivery_tasks WHERE order_id=$1 AND courier_id=$2', [id, actor.id])));
  assert(allowed, 404, 'NOT_FOUND', 'Заказ не найден');
  return order;
}
export async function setStatus(tx: SQL, order: Row, status: string, actorId: string | null) {
  await tx.query('UPDATE orders SET status=$2,updated_at=now() WHERE id=$1', [order.id, status]);
  await tx.query('INSERT INTO order_status_history(order_id,status,actor_id) VALUES($1,$2,$3)', [
    order.id,
    status,
    actorId,
  ]);
  await event(tx, 'order.status', { orderId: order.id, status }, order.user_id);
  for (const role of ['PICKER', 'COURIER', 'ADMIN'])
    await event(tx, 'order.status', { orderId: order.id, status }, null, order.store_id, role);
}
export async function releaseInventory(tx: SQL, order: Row, restock = false) {
  const items = (await tx.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY product_id', [order.id])).rows;
  const ids = [...new Set(items.flatMap(i => [i.product_id, i.replacement_product_id].filter(Boolean)))].sort();
  await tx.query(
    'SELECT * FROM store_products WHERE store_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id FOR UPDATE',
    [order.store_id, ids],
  );
  for (const i of items) {
    const productId = i.replacement_status === 'ACCEPTED' ? i.replacement_product_id : i.product_id;
    if (i.reserved_quantity)
      await tx.query('UPDATE store_products SET reserved=reserved-$3 WHERE store_id=$1 AND product_id=$2', [
        order.store_id,
        productId,
        i.reserved_quantity,
      ]);
    if (restock && i.picking_status !== 'EXCLUDED')
      await tx.query('UPDATE store_products SET stock=stock+$3 WHERE store_id=$1 AND product_id=$2', [
        order.store_id,
        productId,
        i.quantity,
      ]);
    if (i.replacement_status === 'PROPOSED')
      await tx.query('UPDATE store_products SET reserved=reserved-$3 WHERE store_id=$1 AND product_id=$2', [
        order.store_id,
        i.replacement_product_id,
        i.quantity,
      ]);
  }
  await tx.query('UPDATE order_items SET reserved_quantity=0 WHERE order_id=$1', [order.id]);
}
export async function enqueueRefund(tx: SQL, order: Row, amount: number) {
  if (amount <= 0 || order.payment_status !== 'PAID') return;
  const id = randomUUID();
  await tx.query("INSERT INTO refunds(id,order_id,amount,status) VALUES($1,$2,$3,'PENDING')", [id, order.id, amount]);
  await tx.query("INSERT INTO jobs(id,kind,payload,run_at) VALUES($1,'REFUND',$2,now())", [
    randomUUID(),
    JSON.stringify({ refundId: id }),
  ]);
}
export async function cancelOrder(tx: SQL, order: Row, actorId: string | null) {
  assert(
    ['AWAITING_PAYMENT', 'CONFIRMED', 'PICKING'].includes(order.status),
    409,
    'CANNOT_CANCEL',
    'На этом этапе отмена недоступна',
  );
  await releaseInventory(tx, order);
  await enqueueRefund(tx, order, order.total);
  if (order.payment_status === 'PAID')
    await tx.query(
      "UPDATE orders SET payment_status=CASE WHEN total=0 THEN 'REFUNDED' ELSE 'REFUND_PENDING' END WHERE id=$1",
      [order.id],
    );
  await tx.query("UPDATE payments SET status='EXPIRED' WHERE order_id=$1 AND status='PENDING'", [order.id]);
  if (order.promo_code) {
    await tx.query('DELETE FROM promotion_redemptions WHERE order_id=$1', [order.id]);
    await tx.query('UPDATE promotions SET used=used-1 WHERE code=$1 AND used>0', [order.promo_code]);
  }
  await setStatus(tx, order, 'CANCELLED', actorId);
}
export async function recalculate(tx: SQL, order: Row) {
  const items = (await tx.query('SELECT * FROM order_items WHERE order_id=$1', [order.id])).rows;
  const subtotal = items
    .filter(i => i.picking_status !== 'EXCLUDED')
    .reduce((n, i) => n + (i.replacement_status === 'ACCEPTED' ? i.replacement_price : i.unit_price) * i.quantity, 0);
  const pricing = order.pricing_snapshot;
  let discount = 0;
  if (pricing.kind === 'PERCENT') discount = Math.floor((subtotal * Math.min(pricing.value, 100)) / 100);
  if (pricing.kind === 'FIXED') discount = Math.min(subtotal, pricing.value);
  const total = subtotal - discount + order.delivery_fee;
  assert(
    order.payment_method !== 'QR' || total <= order.total,
    409,
    'PRICE_INCREASE_NOT_SUPPORTED',
    'Для предоплаты замена должна быть не дороже исходного товара',
  );
  await enqueueRefund(tx, order, order.total - total);
  await tx.query('UPDATE orders SET subtotal=$2,discount=$3,total=$4,updated_at=now() WHERE id=$1', [
    order.id,
    subtotal,
    discount,
    total,
  ]);
  await event(tx, 'order.repriced', { orderId: order.id, total }, order.user_id);
}
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
    const cart = await one(db, 'SELECT * FROM carts WHERE user_id=$1', [req.actor.id]);
    const items = cart
      ? (
          await db.query(
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
      const cart = await one(tx, 'SELECT * FROM carts WHERE user_id=$1', [req.actor.id]);
      const count = await one(tx, 'SELECT count(*)::int count FROM cart_items WHERE user_id=$1', [req.actor.id]);
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
      const product = await one(
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
    assert(b.paymentMethod !== 'QR' || paymentProvider === 'mock', 503, 'PAYMENTS_DISABLED', 'QR-оплата отключена');
    const hash = sha(JSON.stringify({ expectedTotal, ...b }));
    const result = await db.transaction(async tx => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [req.actor.id]);
      const existing = await one(tx, 'SELECT * FROM orders WHERE user_id=$1 AND idempotency_key=$2', [
        req.actor.id,
        key,
      ]);
      if (existing) {
        assert(existing.request_hash === hash, 409, 'IDEMPOTENCY_CONFLICT', 'Ключ уже использован с другими данными');
        return { order: await orderDetail(tx, existing.id), created: false };
      }
      const q = await quote(tx, req.actor.id, b, true);
      assert(q.total === expectedTotal, 409, 'PRICE_CHANGED', 'Стоимость изменилась. Получите новый расчёт');
      const id = randomUUID(),
        status = b.paymentMethod === 'QR' ? 'AWAITING_PAYMENT' : 'CONFIRMED';
      await tx.query(
        `INSERT INTO orders(id,user_id,store_id,status,payment_method,subtotal,discount,delivery_fee,total,address_snapshot,pricing_snapshot,email,courier_comment,cash_change_from,promo_code,idempotency_key,request_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,CASE WHEN $5='QR' THEN now()+interval '10 minutes' ELSE NULL END)`,
        [
          id,
          req.actor.id,
          q.store.id,
          status,
          b.paymentMethod,
          q.subtotal,
          q.discount,
          q.deliveryFee,
          q.total,
          JSON.stringify(q.address),
          JSON.stringify(q.pricing),
          b.email ?? null,
          b.courierComment,
          b.cashChangeFrom ?? null,
          b.promoCode ?? null,
          key,
          hash,
        ],
      );
      for (const i of q.items) {
        await tx.query('UPDATE store_products SET reserved=reserved+$3 WHERE store_id=$1 AND product_id=$2', [
          q.store.id,
          i.product_id,
          i.quantity,
        ]);
        await tx.query(
          'INSERT INTO order_items(id,order_id,product_id,name_snapshot,unit_snapshot,unit_price,quantity,reserved_quantity) VALUES($1,$2,$3,$4,$5,$6,$7,$7)',
          [randomUUID(), id, i.product_id, JSON.stringify(i.name), i.unit, i.price, i.quantity],
        );
      }
      if (q.promo) {
        await tx.query('UPDATE promotions SET used=used+1 WHERE code=$1', [q.promo.code]);
        await tx.query('INSERT INTO promotion_redemptions(code,user_id,order_id) VALUES($1,$2,$3)', [
          q.promo.code,
          req.actor.id,
          id,
        ]);
      }
      await tx.query('INSERT INTO picking_tasks(order_id) VALUES($1)', [id]);
      await tx.query('INSERT INTO delivery_tasks(order_id) VALUES($1)', [id]);
      const order = (await one(tx, 'SELECT * FROM orders WHERE id=$1', [id]))!;
      await setStatus(tx, order, status, req.actor.id);
      if (b.paymentMethod === 'QR')
        await tx.query(
          "INSERT INTO jobs(id,kind,payload,run_at) VALUES($1,'EXPIRE_ORDER',$2,now()+interval '10 minutes')",
          [randomUUID(), JSON.stringify({ orderId: id })],
        );
      await tx.query('DELETE FROM cart_items WHERE user_id=$1', [req.actor.id]);
      return { order: await orderDetail(tx, id), created: true };
    });
    res.status(result.created ? 201 : 200).json({ data: result.order });
  });
  r.get('/orders', async (req, res) => {
    const p = page(req.query);
    res.json({
      data: (
        await db.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3', [
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
        await tx.query(
          `SELECT COALESCE(CASE WHEN oi.replacement_status='ACCEPTED' THEN oi.replacement_product_id END,oi.product_id) product_id,SUM(oi.quantity)::int quantity FROM order_items oi WHERE order_id=$1 AND picking_status<>'EXCLUDED' AND unit_price>0 GROUP BY 1`,
          [order.id],
        )
      ).rows;
      const unavailable = [];
      for (const i of items) {
        const p = await one(
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
