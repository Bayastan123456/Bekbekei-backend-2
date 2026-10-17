import { one, type Database, type SQL } from '../db.js';
import type { OrderItem, Localized } from '../models.js';
import { assert, event } from '../core.js';
import type { Actor } from '../models.js';
import type { PickingAction } from '../schemas/fulfillment.js';
import { accessOrder, recalculate } from './orders.js';
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
export async function stockLock(tx: SQL, storeId: string, ids: string[]) {
  return tx.query(
    'SELECT * FROM store_products WHERE store_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id FOR UPDATE',
    [storeId, [...new Set(ids)].sort()],
  );
}

export async function handlePickingItem(db: Database, actor: Actor, id: string, itemId: string, b: PickingAction) {
  await db.transaction(async tx => {
    const o = await accessOrder(tx, id, actor, true);
    assert(o.status === 'PICKING', 409, 'INVALID_STATE', 'Заказ не собирается');
    const i = await one<OrderItem>(tx, 'SELECT * FROM order_items WHERE id=$1 AND order_id=$2', [itemId, id]);
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
      const replacement = await one<{ price: number; available: number; age_restricted: boolean; name: Localized }>(
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
}
