import type {
  Address,
  Cart,
  DeliveryTask,
  Order,
  OrderStatus,
  OrderItem,
  PickingTask,
  Promotion,
  Store,
} from '../models.js';
import { randomUUID } from 'node:crypto';
import { one, type Database, type SQL } from '../db.js';
import { assert, event, sha } from '../core.js';
import type { Actor } from '../models.js';
import { distanceKm, isStoreOpen } from './catalog.js';
import type { Checkout } from '../schemas/orders.js';
type QuoteItem = {
  product_id: string;
  quantity: number;
  name: import('../models.js').Localized;
  unit: string;
  price: number;
  available: number;
  active?: boolean;
  age_restricted?: boolean;
  gift?: boolean;
};
export async function quote(tx: SQL, userId: string, b: Checkout, lock = false) {
  const cart = await one<Cart>(tx, 'SELECT * FROM carts WHERE user_id=$1', [userId]);
  assert(cart, 400, 'EMPTY_CART', 'Корзина пуста');
  const store = await one<Store>(tx, 'SELECT * FROM stores WHERE id=$1 AND active', [cart.store_id]);
  assert(store, 400, 'STORE_UNAVAILABLE', 'Магазин недоступен');
  assert(isStoreOpen(store), 409, 'STORE_CLOSED', 'Магазин закрыт');
  const address = await one<Address>(tx, 'SELECT * FROM addresses WHERE id=$1 AND user_id=$2', [b.addressId, userId]);
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
    await tx.query<QuoteItem>(
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
  let promo: Promotion | undefined;
  if (b.promoCode) {
    promo = await one<Promotion>(
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
      const gift = await one<Pick<QuoteItem, 'product_id' | 'name' | 'unit' | 'available'>>(
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
  const order = await one<Order>(tx, 'SELECT * FROM orders WHERE id=$1', [id]);
  assert(order, 404, 'NOT_FOUND', 'Заказ не найден');
  return {
    ...order,
    items: (await tx.query<OrderItem>('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id', [id])).rows,
    history: (await tx.query('SELECT status,created_at FROM order_status_history WHERE order_id=$1 ORDER BY id', [id]))
      .rows,
    picking: await one<PickingTask>(tx, 'SELECT * FROM picking_tasks WHERE order_id=$1', [id]),
    delivery: await one<DeliveryTask>(tx, 'SELECT * FROM delivery_tasks WHERE order_id=$1', [id]),
  };
}
export async function accessOrder(tx: SQL, id: string, actor: Actor, lock = false) {
  const order = await one<Order>(tx, `SELECT * FROM orders WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
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
export async function setStatus(tx: SQL, order: Order, status: OrderStatus, actorId: string | null) {
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
export function inventoryProductId(item: OrderItem) {
  if (item.replacement_status !== 'ACCEPTED') return item.product_id;
  assert(item.replacement_product_id, 500, 'INVALID_ORDER_ITEM', 'У принятой замены отсутствует товар');
  return item.replacement_product_id;
}
export async function releaseInventory(tx: SQL, order: Order, restock = false) {
  const items = (
    await tx.query<OrderItem>('SELECT * FROM order_items WHERE order_id=$1 ORDER BY product_id', [order.id])
  ).rows;
  const ids = [...new Set(items.flatMap(i => [i.product_id, i.replacement_product_id].filter(Boolean)))].sort();
  await tx.query(
    'SELECT * FROM store_products WHERE store_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id FOR UPDATE',
    [order.store_id, ids],
  );
  for (const i of items) {
    const productId = inventoryProductId(i);
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
export async function enqueueRefund(tx: SQL, order: Order, amount: number) {
  if (amount <= 0 || order.payment_status !== 'PAID') return;
  const id = randomUUID();
  await tx.query("INSERT INTO refunds(id,order_id,amount,status) VALUES($1,$2,$3,'PENDING')", [id, order.id, amount]);
  await tx.query("INSERT INTO jobs(id,kind,payload,run_at) VALUES($1,'REFUND',$2,now())", [
    randomUUID(),
    JSON.stringify({ refundId: id }),
  ]);
}
export async function cancelOrder(tx: SQL, order: Order, actorId: string | null) {
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
export async function recalculate(tx: SQL, order: Order) {
  const items = (await tx.query<OrderItem>('SELECT * FROM order_items WHERE order_id=$1', [order.id])).rows;
  const subtotal = items
    .filter(i => i.picking_status !== 'EXCLUDED')
    .reduce((n, i) => {
      if (i.replacement_status === 'ACCEPTED') {
        assert(i.replacement_price !== null, 500, 'INVALID_ORDER_ITEM', 'У принятой замены отсутствует цена');
        return n + i.replacement_price * i.quantity;
      }
      return n + i.unit_price * i.quantity;
    }, 0);
  const pricing = order.pricing_snapshot;
  let discount = 0;
  if (pricing.kind === 'PERCENT') discount = Math.floor((subtotal * Math.min(pricing.value ?? 0, 100)) / 100);
  if (pricing.kind === 'FIXED') discount = Math.min(subtotal, pricing.value ?? 0);
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

export async function createOrder(
  db: Database,
  userId: string,
  b: Checkout,
  expectedTotal: number,
  key: string,
  paymentProvider: string,
) {
  assert(b.paymentMethod !== 'QR' || paymentProvider === 'mock', 503, 'PAYMENTS_DISABLED', 'QR-оплата отключена');
  const hash = sha(JSON.stringify({ expectedTotal, ...b }));
  return db.transaction(async tx => {
    await tx.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [userId]);
    const existing = await one<Order>(tx, 'SELECT * FROM orders WHERE user_id=$1 AND idempotency_key=$2', [
      userId,
      key,
    ]);
    if (existing) {
      assert(existing.request_hash === hash, 409, 'IDEMPOTENCY_CONFLICT', 'Ключ уже использован с другими данными');
      return { order: await orderDetail(tx, existing.id), created: false };
    }
    const q = await quote(tx, userId, b, true);
    assert(q.total === expectedTotal, 409, 'PRICE_CHANGED', 'Стоимость изменилась. Получите новый расчёт');
    const id = randomUUID(),
      status = b.paymentMethod === 'QR' ? 'AWAITING_PAYMENT' : 'CONFIRMED';
    await tx.query(
      `INSERT INTO orders(id,user_id,store_id,status,payment_method,subtotal,discount,delivery_fee,total,address_snapshot,pricing_snapshot,email,courier_comment,cash_change_from,promo_code,idempotency_key,request_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,CASE WHEN $5='QR' THEN now()+interval '10 minutes' ELSE NULL END)`,
      [
        id,
        userId,
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
        userId,
        id,
      ]);
    }
    await tx.query('INSERT INTO picking_tasks(order_id) VALUES($1)', [id]);
    await tx.query('INSERT INTO delivery_tasks(order_id) VALUES($1)', [id]);
    const order = (await one<Order>(tx, 'SELECT * FROM orders WHERE id=$1', [id]))!;
    await setStatus(tx, order, status, userId);
    if (b.paymentMethod === 'QR')
      await tx.query(
        "INSERT INTO jobs(id,kind,payload,run_at) VALUES($1,'EXPIRE_ORDER',$2,now()+interval '10 minutes')",
        [randomUUID(), JSON.stringify({ orderId: id })],
      );
    await tx.query('DELETE FROM cart_items WHERE user_id=$1', [userId]);
    return { order: await orderDetail(tx, id), created: true };
  });
}
