import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { config, passwordHash, event, type Config } from '../src/core.js';
import { one, type Database } from '../src/db.js';
import { migrate } from '../src/scripts/migrate.js';
import { seed, seedIds } from '../src/scripts/seed.js';
import { newSession } from '../src/modules/auth.js';
import { runJobs } from '../src/worker.js';
import { testDatabase } from './database.js';
let db: Database, app: Express, admin: any;
let number = 100000000;
const logs: Record<string, any>[] = [];
const cfg: Config = {
  env: 'test',
  otpSecret: 'test-only-secret-32-characters-long!!',
  webhookSecret: 'test-only-webhook-32-characters-long',
  smsProvider: 'log',
  paymentProvider: 'mock',
  corsOrigins: ['http://localhost:5173'],
  logger: data => logs.push(data),
};
before(async () => {
  db = await testDatabase();
  await migrate(db);
  await seed(db);
  await db.query("UPDATE stores SET opens_at='00:00',closes_at='00:00'");
  app = createApp(db, cfg);
  admin = await actor('ADMIN');
});
after(async () => {
  await db.close();
});
async function actor(role = 'CUSTOMER', storeId = seedIds.store) {
  const id = randomUUID(),
    phone = `+996${++number}`;
  await db.query('INSERT INTO users(id,phone,role,password_hash,first_name) VALUES($1,$2,$3,$4,$5)', [
    id,
    phone,
    role,
    role === 'CUSTOMER' ? null : passwordHash('test-password-12345'),
    'Тест',
  ]);
  if (role !== 'CUSTOMER') await db.query('INSERT INTO staff_stores(user_id,store_id) VALUES($1,$2)', [id, storeId]);
  return { id, phone, role, ...(await newSession(db, id)) };
}
async function call(method: string, path: string, user: any = null, body?: any, status = 200, headers: any = {}) {
  let q = (request(app) as any)[method](`/api/v1${path}`);
  if (user) q = q.set('Authorization', `Bearer ${user.accessToken}`);
  for (const [key, value] of Object.entries(headers)) q = q.set(key, value);
  if (body !== undefined) q = q.send(body);
  const res = await q;
  assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(res.body)}`);
  return res.body.data;
}
async function address(user: any, overrides: any = {}) {
  return call(
    'post',
    '/me/addresses',
    user,
    { street: 'Проспект Чуй, 230', latitude: 42.8746, longitude: 74.5698, ...overrides },
    201,
  );
}
async function setup(user?: any, productId = seedIds.lemon, quantity = 1) {
  const customer = user ?? (await actor()),
    addr = await address(customer);
  await call('put', `/cart/items/${productId}`, customer, { storeId: seedIds.store, quantity }, 204);
  return { customer, body: { addressId: addr.id, paymentMethod: 'CASH' } };
}
async function order(user: any, body: any, key = randomUUID()) {
  const q = await call('post', '/checkout/quote', user, body);
  return call('post', '/orders', user, { ...body, expectedTotal: q.total }, 201, { 'Idempotency-Key': key });
}
async function staffFor(o: any) {
  const picker = await actor('PICKER'),
    courier = await actor('COURIER');
  await call('post', '/courier/shifts/start', courier);
  await call('post', `/picking/tasks/${o.id}/claim`, picker);
  await call('post', `/delivery/tasks/${o.id}/claim`, courier);
  return { picker, courier };
}
async function ready(o: any, picker: any) {
  for (const i of o.items) await call('patch', `/picking/tasks/${o.id}/items/${i.id}`, picker, { action: 'PICK' });
  await call('post', `/picking/tasks/${o.id}/complete`, picker);
}
async function payment(customer: any, o: any) {
  return call('post', `/orders/${o.id}/payments`, customer, {}, 201, { 'Idempotency-Key': randomUUID() });
}
async function webhook(p: any, status = 'PAID', eventId = randomUUID(), signed = true) {
  const b = JSON.stringify({ eventId, paymentId: p.id, status, amount: p.amount });
  const signature = createHmac('sha256', cfg.webhookSecret).update(b).digest('hex');
  const r = await request(app)
    .post('/api/v1/webhooks/payments/mock')
    .set('Content-Type', 'application/json')
    .set('X-Payment-Signature', signed ? signature : 'bad')
    .send(b);
  assert.equal(r.status, signed ? 200 : 401, JSON.stringify(r.body));
  return r.body.data;
}
test('миграции повторяются безопасно, публичные маршруты доступны без входа', async () => {
  await migrate(db);
  await call('get', '/stores');
  await call('get', `/products?storeId=${seedIds.store}`);
  assert.equal((await request(app).get('/docs/')).status, 200);
  assert.equal((await request(app).get('/admin/')).status, 200);
  assert.equal((await request(app).get('/openapi.json')).status, 200);
  await call('get', '/me', null, undefined, 401);
  await call('get', '/admin/orders', null, undefined, 401);
});
test('SMS-код только в логе; согласие, cooldown, одноразовое использование', async () => {
  const phone = `+996${++number}`;
  await call('post', '/auth/otp/request', null, { phone }, 422);
  const r = await call('post', '/auth/otp/request', null, { phone, consent: true }, 202);
  assert.equal(r.code, undefined);
  await call('post', '/auth/otp/request', null, { phone, consent: true }, 429);
  const code = logs.findLast(l => l.type === 'development.otp' && l.phone === phone)!.code;
  const session = await call('post', '/auth/otp/verify', null, { phone, code });
  assert.equal(session.user.role, 'CUSTOMER');
  await call('post', '/auth/otp/verify', null, { phone, code }, 400);
  await call('post', '/auth/otp/request', null, { phone: admin.phone, consent: true }, 403);
});
test('код входа виден администратору до подтверждения и пропадает после', async () => {
  const phone = `+996${++number}`;
  await call('post', '/auth/otp/request', null, { phone, consent: true }, 202);
  const code = logs.findLast(l => l.type === 'development.otp' && l.phone === phone)!.code;
  await call('get', '/admin/otp-codes', null, undefined, 401);
  const codes = await call('get', '/admin/otp-codes', admin);
  assert.ok(codes.some((c: any) => c.phone === phone && c.code === code));
  await call('post', '/auth/otp/verify', null, { phone, code });
  const after = await call('get', '/admin/otp-codes', admin);
  assert.ok(!after.some((c: any) => c.phone === phone));
});
test('пять неверных кодов блокируют правильный код, попытки сохраняются', async () => {
  const phone = `+996${++number}`;
  await call('post', '/auth/otp/request', null, { phone, consent: true }, 202);
  const code = logs.findLast(l => l.phone === phone)!.code;
  for (let i = 0; i < 5; i++)
    await call('post', '/auth/otp/verify', null, { phone, code: code === '0000' ? '0001' : '0000' }, 400);
  await call('post', '/auth/otp/verify', null, { phone, code }, 400);
  assert.equal((await one(db, 'SELECT attempts FROM otp_challenges WHERE phone=$1', [phone]))!.attempts, 5);
});
test('истёкший код отклоняется', async () => {
  const phone = `+996${++number}`;
  await call('post', '/auth/otp/request', null, { phone, consent: true }, 202);
  const code = logs.findLast(l => l.phone === phone)!.code;
  await db.query("UPDATE otp_challenges SET expires_at=now()-interval '1 second' WHERE phone=$1", [phone]);
  await call('post', '/auth/otp/verify', null, { phone, code }, 400);
});
test('вход сотрудника, ротация refresh-токена и отзыв сеанса', async () => {
  const staff = await actor('PICKER');
  await call('post', '/auth/staff/login', null, { phone: staff.phone, password: 'wrong' }, 401);
  const session = await call('post', '/auth/staff/login', null, {
    phone: staff.phone,
    password: 'test-password-12345',
  });
  const rotated = await call('post', '/auth/refresh', null, { refreshToken: session.refreshToken });
  await call('post', '/auth/refresh', null, { refreshToken: session.refreshToken }, 401);
  await call('get', '/me', session, undefined, 401);
  await call('post', '/auth/logout', rotated, {}, 204);
  await call('get', '/me', rotated, undefined, 401);
});
test('production не запускается с кодами в логе', () => {
  const old = { ...process.env };
  process.env.NODE_ENV = 'production';
  process.env.OTP_SECRET = cfg.otpSecret;
  process.env.PAYMENT_WEBHOOK_SECRET = cfg.webhookSecret;
  try {
    assert.throws(() => config(), /production/);
  } finally {
    process.env = old;
  }
});
test('адреса и профиль защищены; смена роли через профиль запрещена', async () => {
  const a = await actor(),
    b = await actor(),
    addr = await address(a);
  await call('delete', `/me/addresses/${addr.id}`, b, undefined, 404);
  await call('patch', '/me', a, { role: 'ADMIN' }, 422);
  await call('patch', '/me', a, { firstName: 'Аяна', language: 'ky' });
  assert.equal((await call('get', '/me', a)).first_name, 'Аяна');
  await call('get', '/admin/orders', a, undefined, 403);
});
test('избранное сохраняется и удаляется', async () => {
  const u = await actor();
  await call('put', `/me/favorites/${seedIds.lemon}`, u, {}, 204);
  assert.equal((await call('get', `/me/favorites?storeId=${seedIds.store}`, u)).length, 1);
  await call('delete', `/me/favorites/${seedIds.lemon}`, u, undefined, 204);
  assert.equal((await call('get', `/me/favorites?storeId=${seedIds.store}`, u)).length, 0);
});
test('полный заказ наличными, доставка, единственное начисление, история покупок', async () => {
  const { customer, body } = await setup();
  const o = await order(customer, body);
  assert.equal(o.total, 13000);
  assert.equal(o.delivery_fee, 0);
  const { picker, courier } = await staffFor(o);
  await call('post', `/delivery/tasks/${o.id}/pickup`, courier, {}, 409);
  await ready(o, picker);
  await call('post', `/delivery/tasks/${o.id}/pickup`, courier);
  await call('post', `/delivery/tasks/${o.id}/arrive`, courier, {}, 204);
  await call('post', `/delivery/tasks/${o.id}/complete`, courier, {}, 409);
  await call('post', `/delivery/tasks/${o.id}/confirm-cash`, courier, {}, 204);
  await call('post', `/delivery/tasks/${o.id}/complete`, courier);
  await call('post', `/delivery/tasks/${o.id}/complete`, courier);
  assert.equal((await call('get', '/courier/statistics', courier)).earnings, 8000);
  await call('put', `/orders/${o.id}/rating`, customer, { score: 5 }, 204);
  assert.equal((await call('get', '/courier/statistics', courier)).rating, 5);
  assert.equal((await call('get', `/me/purchased?storeId=${seedIds.store}`, customer)).length, 1);
  await call('post', '/courier/shifts/end', courier, {}, 204);
});
test('стоимость перепроверяется; неизвестные поля и чужие адреса отклоняются', async () => {
  const { customer, body } = await setup();
  await call('post', '/orders', customer, { ...body, expectedTotal: 1 }, 409, { 'Idempotency-Key': randomUUID() });
  await call('post', '/orders', customer, { ...body, expectedTotal: 13000, total: 1 }, 422, {
    'Idempotency-Key': randomUUID(),
  });
  const other = await actor(),
    addr = await address(other);
  await call('post', '/checkout/quote', customer, { ...body, addressId: addr.id }, 404);
});
test('адрес вне зоны и закрытый магазин блокируют оформление', async () => {
  const { customer, body } = await setup();
  const addr = await address(customer, { latitude: 0, longitude: 0 });
  await call('post', '/checkout/quote', customer, { ...body, addressId: addr.id }, 422);
  const saved = (await one(db, 'SELECT * FROM stores WHERE id=$1', [seedIds.store]))!;
  const current = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bishkek',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date());
  const hour = (Number(current.slice(0, 2)) + 2) % 24,
    from = String(hour).padStart(2, '0') + ':00',
    to = String((hour + 1) % 24).padStart(2, '0') + ':00';
  await db.query('UPDATE stores SET opens_at=$2,closes_at=$3 WHERE id=$1', [seedIds.store, from, to]);
  try {
    await call('post', '/checkout/quote', customer, body, 409);
  } finally {
    await db.query('UPDATE stores SET opens_at=$2,closes_at=$3 WHERE id=$1', [
      seedIds.store,
      saved.opens_at,
      saved.closes_at,
    ]);
  }
});
test('один ключ создаёт один заказ; изменение данных с тем же ключом отклоняется', async () => {
  const { customer, body } = await setup(),
    q = await call('post', '/checkout/quote', customer, body),
    key = randomUUID(),
    b = { ...body, expectedTotal: q.total };
  const responses = await Promise.all([
    request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .set('Idempotency-Key', key)
      .send(b),
    request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .set('Idempotency-Key', key)
      .send(b),
  ]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 201]);
  assert.equal(responses[0].body.data.id, responses[1].body.data.id);
  await call('post', '/orders', customer, { ...b, courierComment: 'Другое' }, 409, { 'Idempotency-Key': key });
  await call('post', `/orders/${responses[0].body.data.id}/cancel`, customer);
});
test('отмена освобождает резерв один раз; чужой заказ недоступен', async () => {
  const { customer, body } = await setup(),
    before = (await one(db, 'SELECT reserved FROM store_products WHERE store_id=$1 AND product_id=$2', [
      seedIds.store,
      seedIds.lemon,
    ]))!.reserved;
  const o = await order(customer, body);
  const other = await actor();
  await call('get', `/orders/${o.id}`, other, undefined, 404);
  await call('post', `/orders/${o.id}/cancel`, other, {}, 404);
  await call('post', `/orders/${o.id}/cancel`, customer);
  await call('post', `/orders/${o.id}/cancel`, customer);
  assert.equal(
    (await one(db, 'SELECT reserved FROM store_products WHERE store_id=$1 AND product_id=$2', [
      seedIds.store,
      seedIds.lemon,
    ]))!.reserved,
    before,
  );
});
test('два покупателя конкурируют за последнюю единицу: только один заказ', async () => {
  const id = randomUUID();
  await db.query('INSERT INTO products(id,category_id,name,unit) VALUES($1,$2,$3,$4)', [
    id,
    seedIds.category,
    JSON.stringify({ ru: 'Последний товар' }),
    '1 шт.',
  ]);
  await call('put', '/admin/inventory', admin, { storeId: seedIds.store, productId: id, price: 10000, stock: 1 }, 204);
  const a = await setup(undefined, id),
    b = await setup(undefined, id);
  const qa = await call('post', '/checkout/quote', a.customer, a.body),
    qb = await call('post', '/checkout/quote', b.customer, b.body);
  const responses = await Promise.all(
    [a, b].map((s, i) =>
      request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${s.customer.accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ ...s.body, expectedTotal: [qa, qb][i].total }),
    ),
  );
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  const winner = responses.find(r => r.status === 201)!;
  assert.equal((await one(db, 'SELECT reserved FROM store_products WHERE product_id=$1', [id]))!.reserved, 1);
  await call('put', '/admin/inventory', admin, { storeId: seedIds.store, productId: id, price: 10000, stock: 0 }, 409);
  const user = winner.body.data.user_id === a.customer.id ? a.customer : b.customer;
  await call('post', `/orders/${winner.body.data.id}/cancel`, user);
});
test('два сборщика не могут взять один заказ; другой магазин недоступен', async () => {
  const { customer, body } = await setup(),
    o = await order(customer, body),
    a = await actor('PICKER'),
    b = await actor('PICKER');
  const outsider = await actor('PICKER');
  await db.query('DELETE FROM staff_stores WHERE user_id=$1', [outsider.id]);
  await call('post', `/picking/tasks/${o.id}/claim`, outsider, {}, 403);
  assert.equal((await call('get', '/picking/tasks', outsider)).length, 0);
  const responses = await Promise.all(
    [a, b].map(s =>
      request(app).post(`/api/v1/picking/tasks/${o.id}/claim`).set('Authorization', `Bearer ${s.accessToken}`),
    ),
  );
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  await call('post', `/picking/tasks/${o.id}/claim`, customer, {}, 403);
  await call('post', `/orders/${o.id}/cancel`, customer);
});
test('два курьера не могут взять один заказ, смена обязательна', async () => {
  const { customer, body } = await setup(),
    o = await order(customer, body),
    a = await actor('COURIER'),
    b = await actor('COURIER');
  await call('post', `/delivery/tasks/${o.id}/claim`, a, {}, 409);
  await call('post', '/courier/shifts/start', a);
  await call('post', '/courier/shifts/start', b);
  const responses = await Promise.all(
    [a, b].map(s =>
      request(app).post(`/api/v1/delivery/tasks/${o.id}/claim`).set('Authorization', `Bearer ${s.accessToken}`),
    ),
  );
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const assigned = responses[0].status === 200 ? a : b;
  await call('post', '/courier/shifts/end', assigned, {}, 409);
  await call('post', `/orders/${o.id}/cancel`, customer);
  await call('post', '/courier/shifts/end', assigned, {}, 204);
});
test('платёж с неверной суммой отклоняется, успешный повтор новой попытки не удваивает заказ', async () => {
  const { customer, body } = await setup(),
    o = await order(customer, { ...body, paymentMethod: 'QR' }),
    p = await payment(customer, o);
  const raw = JSON.stringify({ eventId: randomUUID(), paymentId: p.id, status: 'PAID', amount: p.amount + 1 }),
    sig = createHmac('sha256', cfg.webhookSecret).update(raw).digest('hex');
  assert.equal(
    (
      await request(app)
        .post('/api/v1/webhooks/payments/mock')
        .set('Content-Type', 'application/json')
        .set('X-Payment-Signature', sig)
        .send(raw)
    ).status,
    422,
  );
  await webhook(p, 'FAILED');
  const second = await payment(customer, o);
  assert.notEqual(second.id, p.id);
  await webhook(second);
  await webhook(p);
  await runJobs(db, cfg);
  const result = await call('get', `/orders/${o.id}`, customer);
  assert.equal(result.status, 'CONFIRMED');
  assert.equal(result.payment_status, 'PAID');
  assert.equal(
    (await one(db, 'SELECT sum(amount)::int amount FROM refunds WHERE order_id=$1', [o.id]))!.amount,
    p.amount,
  );
  await call('post', `/orders/${o.id}/cancel`, customer);
  await runJobs(db, cfg);
});
test('SSE не раскрывает события другого клиента и требует авторизацию', async () => {
  const a = await actor(),
    b = await actor();
  await event(db, 'test.private', { secret: 'other-customer' }, b.id);
  await event(db, 'test.own', { message: 'visible' }, a.id);
  await call('get', '/events', null, undefined, 401);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const controller = new AbortController();
  try {
    const port = (server.address() as any).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/events`, {
      headers: { Authorization: `Bearer ${a.accessToken}` },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(),
      data = await reader.read(),
      text = new TextDecoder().decode(data.value);
    assert.match(text, /test.own/);
    assert.doesNotMatch(text, /other-customer/);
    await reader.cancel();
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
test('QR webhook проверяет подпись и повторные события', async () => {
  const { customer, body } = await setup(),
    o = await order(customer, { ...body, paymentMethod: 'QR' }),
    p = await payment(customer, o);
  assert.equal(p.testMode, true);
  await webhook(p, 'PAID', randomUUID(), false);
  const eventId = randomUUID();
  await webhook(p, 'PAID', eventId);
  assert.equal((await webhook(p, 'PAID', eventId)).duplicate, true);
  assert.equal((await call('get', `/orders/${o.id}`, customer)).status, 'CONFIRMED');
  await call('post', `/orders/${o.id}/cancel`, customer);
  await runJobs(db, cfg);
  assert.equal((await call('get', `/orders/${o.id}`, customer)).payment_status, 'REFUNDED');
  assert.equal((await db.query('SELECT * FROM refunds WHERE order_id=$1', [o.id])).rows.length, 1);
});
test('поздняя QR-оплата отменённого заказа возвращается', async () => {
  const { customer, body } = await setup(),
    o = await order(customer, { ...body, paymentMethod: 'QR' }),
    p = await payment(customer, o);
  await call('post', `/orders/${o.id}/cancel`, customer);
  await webhook(p);
  await runJobs(db, cfg);
  const result = await call('get', `/orders/${o.id}`, customer);
  assert.equal(result.status, 'CANCELLED');
  assert.equal(result.payment_status, 'REFUNDED');
});
test('неоплаченный заказ истекает через сохранённую задачу', async () => {
  const { customer, body } = await setup(),
    o = await order(customer, { ...body, paymentMethod: 'QR' });
  await db.query("UPDATE orders SET expires_at=now()-interval '1 second' WHERE id=$1", [o.id]);
  await db.query("UPDATE jobs SET run_at=now()-interval '1 second' WHERE payload->>'orderId'=$1", [o.id]);
  await runJobs(db, cfg);
  assert.equal((await call('get', `/orders/${o.id}`, customer)).status, 'CANCELLED');
});
test('исключение товара пересчитывает сумму и возвращает резерв', async () => {
  const { customer, body } = await setup();
  await call('put', `/cart/items/${seedIds.yogurt}`, customer, { storeId: seedIds.store, quantity: 1 }, 204);
  const o = await order(customer, body),
    { picker } = await staffFor(o);
  const i = o.items.find((i: any) => i.product_id === seedIds.yogurt);
  await call('patch', `/picking/tasks/${o.id}/items/${i.id}`, picker, { action: 'EXCLUDE' });
  const changed = await call('get', `/orders/${o.id}`, customer);
  assert.equal(changed.total, 13000);
  await call('post', `/picking/tasks/${o.id}/complete`, picker, {}, 409);
  await call('post', `/orders/${o.id}/cancel`, customer);
});
test('замена требует согласия; предоплата частично возвращается', async () => {
  const { customer, body } = await setup(),
    o = await order(customer, { ...body, paymentMethod: 'QR' }),
    p = await payment(customer, o);
  await webhook(p);
  const { picker } = await staffFor(o),
    i = o.items[0];
  await call(
    'patch',
    `/picking/tasks/${o.id}/items/${i.id}`,
    picker,
    { action: 'PROPOSE_REPLACEMENT', productId: seedIds.yogurt },
    422,
  );
  await call('patch', `/picking/tasks/${o.id}/items/${i.id}`, picker, {
    action: 'PROPOSE_REPLACEMENT',
    productId: seedIds.bread,
  });
  await call('post', `/picking/tasks/${o.id}/complete`, picker, {}, 409);
  await call('post', `/orders/${o.id}/items/${i.id}/replacement`, customer, { accept: true });
  await runJobs(db, cfg);
  assert.equal((await call('get', `/orders/${o.id}`, customer)).total, 8000);
  assert.equal((await one(db, 'SELECT sum(amount)::int amount FROM refunds WHERE order_id=$1', [o.id]))!.amount, 5000);
  await call('post', `/orders/${o.id}/cancel`, customer);
  await runJobs(db, cfg);
  assert.equal((await one(db, 'SELECT sum(amount)::int amount FROM refunds WHERE order_id=$1', [o.id]))!.amount, 13000);
});
test('отклонённая замена освобождает дополнительный резерв', async () => {
  const { customer, body } = await setup(),
    o = await order(customer, body),
    { picker } = await staffFor(o),
    i = o.items[0];
  const before = (await one(db, 'SELECT reserved FROM store_products WHERE product_id=$1', [seedIds.bread]))!.reserved;
  await call('patch', `/picking/tasks/${o.id}/items/${i.id}`, picker, {
    action: 'PROPOSE_REPLACEMENT',
    productId: seedIds.bread,
  });
  await call('post', `/orders/${o.id}/items/${i.id}/replacement`, customer, { accept: false });
  assert.equal(
    (await one(db, 'SELECT reserved FROM store_products WHERE product_id=$1', [seedIds.bread]))!.reserved,
    before,
  );
  await call('post', `/orders/${o.id}/cancel`, customer);
});
test('клиент не отвечает: таймер переводит в возврат, остатки восстанавливаются', async () => {
  const { customer, body } = await setup(),
    before = (await one(db, 'SELECT stock FROM store_products WHERE product_id=$1', [seedIds.lemon]))!.stock,
    o = await order(customer, body),
    { picker, courier } = await staffFor(o);
  await ready(o, picker);
  await call('post', `/delivery/tasks/${o.id}/pickup`, courier);
  await call('post', `/delivery/tasks/${o.id}/arrive`, courier, {}, 204);
  await call('post', `/orders/${o.id}/cancel`, customer, {}, 409);
  await call('post', `/delivery/tasks/${o.id}/return`, courier, {}, 409);
  await call('post', `/delivery/tasks/${o.id}/report-unreachable`, courier);
  await db.query("UPDATE orders SET waiting_until=now()-interval '1 second' WHERE id=$1", [o.id]);
  await db.query(
    "UPDATE jobs SET run_at=now()-interval '1 second' WHERE kind='UNREACHABLE_ORDER' AND payload->>'orderId'=$1",
    [o.id],
  );
  await runJobs(db, cfg);
  await call('post', `/delivery/tasks/${o.id}/return`, courier);
  await call('post', `/delivery/tasks/${o.id}/return`, courier);
  assert.equal((await one(db, 'SELECT stock FROM store_products WHERE product_id=$1', [seedIds.lemon]))!.stock, before);
});
test('промокод применяется один раз, отмена возвращает доступность', async () => {
  const { customer, body } = await setup(),
    o = await order(customer, { ...body, promoCode: 'WELCOME10' });
  assert.equal(o.total, 11700);
  await call('put', `/cart/items/${seedIds.lemon}`, customer, { storeId: seedIds.store, quantity: 1 }, 204);
  await call('post', '/checkout/quote', customer, { ...body, promoCode: 'WELCOME10' }, 422);
  await call('post', `/orders/${o.id}/cancel`, customer);
  assert.equal((await call('post', '/checkout/quote', customer, { ...body, promoCode: 'WELCOME10' })).total, 11700);
});
test('подарочная акция резервирует подарок с нулевой ценой', async () => {
  await call(
    'post',
    '/admin/promotions',
    admin,
    {
      code: 'TEST_GIFT',
      kind: 'GIFT',
      giftProductId: seedIds.bread,
      triggerProductIds: [seedIds.lemon],
      startsAt: new Date(Date.now() - 1000).toISOString(),
      endsAt: new Date(Date.now() + 86400000).toISOString(),
      usageLimit: 100,
    },
    201,
  );
  const { customer, body } = await setup(),
    o = await order(customer, { ...body, promoCode: 'TEST_GIFT' });
  assert.equal(o.items.length, 2);
  assert.equal(o.items.find((i: any) => i.product_id === seedIds.bread).unit_price, 0);
  await call('post', `/orders/${o.id}/cancel`, customer);
});
test('повтор заказа создаёт корзину с текущими ценами', async () => {
  const { customer, body } = await setup(),
    o = await order(customer, body);
  await call('post', `/orders/${o.id}/cancel`, customer);
  await call('post', `/orders/${o.id}/repeat`, customer);
  const cart = await call('get', '/cart', customer);
  assert.equal(cart.items.length, 1);
  await call('post', `/orders/${o.id}/repeat`, customer, {}, 409);
});
test('поддержка видит только свои сообщения, администратор отвечает', async () => {
  const a = await actor(),
    b = await actor(),
    thread = await call('post', '/support/threads', a, { message: 'Помогите' }, 201);
  await call('get', `/support/threads/${thread.id}/messages`, b, undefined, 404);
  await call('post', `/support/threads/${thread.id}/messages`, admin, { message: 'Здравствуйте' }, 201);
  assert.equal((await call('get', `/support/threads/${thread.id}/messages`, a)).length, 2);
  await call('patch', `/support/threads/${thread.id}`, admin, { status: 'CLOSED' });
  await call('post', `/support/threads/${thread.id}/messages`, a, { message: 'Ещё' }, 409);
});
test('администратор создаёт сотрудника, блокировка отзывает доступ', async () => {
  const phone = `+996${++number}`,
    u = await call(
      'post',
      '/admin/staff',
      admin,
      { phone, password: 'new-staff-password-123', role: 'PICKER', firstName: 'Сборщик', storeIds: [seedIds.store] },
      201,
    );
  const session = await call('post', '/auth/staff/login', null, { phone, password: 'new-staff-password-123' });
  await call('patch', `/admin/staff/${u.id}`, admin, { active: false }, 204);
  await call('get', '/me', session, undefined, 401);
});
test('плохая фоновая задача сохраняет попытку и ошибку без потери задачи', async () => {
  const id = randomUUID();
  await db.query("INSERT INTO jobs(id,kind,payload,run_at) VALUES($1,'UNKNOWN','{}',now())", [id]);
  await runJobs(db, cfg);
  const j = (await one(db, 'SELECT * FROM jobs WHERE id=$1', [id]))!;
  assert.equal(j.attempts, 1);
  assert.equal(j.completed_at, null);
  assert.match(j.last_error, /Unknown job/);
});
