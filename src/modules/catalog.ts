import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, type Database, type SQL, type Row } from '../db.js';
import { assert, language, page, uuid } from '../core.js';
import { authentication, roles } from './auth.js';
export const addressSchema = z
  .object({
    label: z.string().max(60).default(''),
    street: z.string().min(3).max(300),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    entrance: z.string().max(30).default(''),
    intercom: z.string().max(30).default(''),
    floor: z.string().max(30).default(''),
    apartment: z.string().max(30).default(''),
    comment: z.string().max(1000).default(''),
  })
  .strict();
export function distanceKm(a: Row, b: Row) {
  const r = Math.PI / 180,
    lat1 = Number(a.latitude) * r,
    lat2 = Number(b.latitude) * r;
  const x =
    Math.sin((lat2 - lat1) / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(((Number(b.longitude) - Number(a.longitude)) * r) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
export function isStoreOpen(store: Row, date = new Date()) {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: store.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  const from = String(store.opens_at).slice(0, 5),
    to = String(store.closes_at).slice(0, 5);
  return from === to || (from < to ? time >= from && time < to : time >= from || time < to);
}
export async function productList(db: SQL, query: Record<string, unknown>, userId?: string) {
  const { limit, offset } = page(query);
  const storeId = uuid.parse(query.storeId),
    lang = language.parse(query.language ?? 'ru');
  const categoryId = query.categoryId ? uuid.parse(query.categoryId) : null;
  const search = z
    .string()
    .max(100)
    .parse(query.search ?? '');
  const filter = z.enum(['all', 'new', 'favorites', 'purchased']).parse(query.filter ?? 'all');
  assert(!['favorites', 'purchased'].includes(filter) || userId, 401, 'UNAUTHENTICATED', 'Требуется вход');
  return (
    await db.query(
      `SELECT p.*,COALESCE(p.name->>$2,p.name->>'ru') title,sp.price,sp.stock-sp.reserved available,
    CASE WHEN sp.stock-sp.reserved=0 THEN 'OUT_OF_STOCK' WHEN sp.stock-sp.reserved<5 THEN 'LOW_STOCK' ELSE 'AVAILABLE' END availability
    FROM products p JOIN store_products sp ON sp.product_id=p.id WHERE sp.store_id=$1 AND p.active
    AND ($3::uuid IS NULL OR p.category_id=$3) AND ($4='' OR p.name::text ILIKE '%'||$4||'%')
    AND ($5<>'new' OR p.is_new)
    AND ($5<>'favorites' OR EXISTS(SELECT 1 FROM favorites f WHERE f.user_id=$6 AND f.product_id=p.id))
    AND ($5<>'purchased' OR EXISTS(SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.user_id=$6 AND o.status='DELIVERED' AND oi.product_id=p.id AND oi.picking_status<>'EXCLUDED'))
    ORDER BY p.created_at DESC,p.id LIMIT $7 OFFSET $8`,
      [storeId, lang, categoryId, search, filter, userId ?? null, limit, offset],
    )
  ).rows;
}
export function catalogRoutes(db: Database) {
  const r = Router();
  r.get('/stores', async (_req, res) =>
    res.json({ data: (await db.query('SELECT * FROM stores WHERE active ORDER BY name')).rows }),
  );
  r.get('/delivery/availability', async (req, res) => {
    const point = z
      .object({ latitude: z.coerce.number().min(-90).max(90), longitude: z.coerce.number().min(-180).max(180) })
      .parse(req.query);
    const stores = (await db.query('SELECT * FROM stores WHERE active')).rows
      .map(s => ({ ...s, distanceKm: distanceKm(s, point), open: isStoreOpen(s), radiusKm: Number(s.radius_km) }))
      .filter(s => s.distanceKm <= s.radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);
    res.json({ data: { available: stores.some(s => s.open), stores } });
  });
  r.get('/categories', async (_req, res) =>
    res.json({ data: (await db.query('SELECT * FROM categories ORDER BY sort,id')).rows }),
  );
  r.get('/products', async (req, res) => res.json({ data: await productList(db, req.query) }));
  r.get('/products/:id', async (req, res) => {
    const id = uuid.parse(req.params.id),
      storeId = uuid.parse(req.query.storeId);
    const product = await one(
      db,
      'SELECT p.*,sp.price,sp.stock-sp.reserved available FROM products p JOIN store_products sp ON sp.product_id=p.id WHERE p.id=$1 AND sp.store_id=$2 AND p.active',
      [id, storeId],
    );
    assert(product, 404, 'NOT_FOUND', 'Товар не найден');
    res.json({
      data: {
        ...product,
        recommendations: await productList(db, { storeId, categoryId: product.category_id, limit: 8 }),
      },
    });
  });
  r.get('/home', async (req, res) => {
    const storeId = uuid.parse(req.query.storeId);
    const store = await one(db, 'SELECT * FROM stores WHERE id=$1 AND active', [storeId]);
    assert(store, 404, 'NOT_FOUND', 'Магазин не найден');
    res.json({
      data: {
        store,
        open: isStoreOpen(store),
        content: (await db.query('SELECT * FROM content WHERE active ORDER BY sort,id')).rows,
        products: await productList(db, { ...req.query, storeId, limit: 20 }),
        delivery: { fee: store.delivery_fee, etaMinutes: { min: 20, max: 25 }, estimate: true },
      },
    });
  });
  r.get('/content', async (req, res) => {
    const kind = z.enum(['BANNER', 'STORY', 'NOTICE', 'DOCUMENT', 'COLLECTION']).optional().parse(req.query.kind);
    res.json({
      data: (
        await db.query('SELECT * FROM content WHERE active AND ($1::text IS NULL OR kind=$1) ORDER BY sort,id', [
          kind ?? null,
        ])
      ).rows,
    });
  });
  return r;
}
export function userRoutes(db: Database) {
  const r = Router();
  r.use((req, _res, next) => (req.path === '/me' || req.path.startsWith('/me/') ? next() : next('router')));
  r.use(authentication(db));
  r.get('/me', async (req, res) =>
    res.json({
      data: await one(db, 'SELECT id,phone,first_name,last_name,language,email,role FROM users WHERE id=$1', [
        req.actor.id,
      ]),
    }),
  );
  r.patch('/me', async (req, res) => {
    const b = z
      .object({
        firstName: z.string().min(1).max(80).optional(),
        lastName: z.string().max(80).optional(),
        language: language.optional(),
        email: z.email().max(254).nullable().optional(),
      })
      .strict()
      .parse(req.body);
    res.json({
      data: await one(
        db,
        `UPDATE users SET first_name=COALESCE($2,first_name),last_name=COALESCE($3,last_name),language=COALESCE($4,language),email=CASE WHEN $5 THEN $6 ELSE email END WHERE id=$1 RETURNING id,phone,first_name,last_name,language,email,role`,
        [req.actor.id, b.firstName ?? null, b.lastName ?? null, b.language ?? null, 'email' in b, b.email ?? null],
      ),
    });
  });
  r.get('/me/addresses', roles('CUSTOMER'), async (req, res) =>
    res.json({ data: (await db.query('SELECT * FROM addresses WHERE user_id=$1 ORDER BY id', [req.actor.id])).rows }),
  );
  r.post('/me/addresses', roles('CUSTOMER'), async (req, res) => {
    const b = addressSchema.parse(req.body),
      id = randomUUID();
    res
      .status(201)
      .json({
        data: await one(
          db,
          `INSERT INTO addresses(id,user_id,label,street,latitude,longitude,entrance,intercom,floor,apartment,comment) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            id,
            req.actor.id,
            b.label,
            b.street,
            b.latitude,
            b.longitude,
            b.entrance,
            b.intercom,
            b.floor,
            b.apartment,
            b.comment,
          ],
        ),
      });
  });
  r.put('/me/addresses/:id', roles('CUSTOMER'), async (req, res) => {
    const b = addressSchema.parse(req.body),
      id = uuid.parse(req.params.id);
    const row = await one(
      db,
      `UPDATE addresses SET label=$3,street=$4,latitude=$5,longitude=$6,entrance=$7,intercom=$8,floor=$9,apartment=$10,comment=$11 WHERE id=$1 AND user_id=$2 RETURNING *`,
      [
        id,
        req.actor.id,
        b.label,
        b.street,
        b.latitude,
        b.longitude,
        b.entrance,
        b.intercom,
        b.floor,
        b.apartment,
        b.comment,
      ],
    );
    assert(row, 404, 'NOT_FOUND', 'Адрес не найден');
    res.json({ data: row });
  });
  r.delete('/me/addresses/:id', roles('CUSTOMER'), async (req, res) => {
    const result = await db.query('DELETE FROM addresses WHERE id=$1 AND user_id=$2', [
      uuid.parse(req.params.id),
      req.actor.id,
    ]);
    assert(result.rowCount, 404, 'NOT_FOUND', 'Адрес не найден');
    res.status(204).end();
  });
  r.get('/me/favorites', roles('CUSTOMER'), async (req, res) =>
    res.json({ data: await productList(db, { ...req.query, filter: 'favorites' }, req.actor.id) }),
  );
  r.get('/me/purchased', roles('CUSTOMER'), async (req, res) =>
    res.json({ data: await productList(db, { ...req.query, filter: 'purchased' }, req.actor.id) }),
  );
  r.put('/me/favorites/:id', roles('CUSTOMER'), async (req, res) => {
    const id = uuid.parse(req.params.id);
    assert(await one(db, 'SELECT id FROM products WHERE id=$1 AND active', [id]), 404, 'NOT_FOUND', 'Товар не найден');
    await db.query('INSERT INTO favorites(user_id,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [
      req.actor.id,
      id,
    ]);
    res.status(204).end();
  });
  r.delete('/me/favorites/:id', roles('CUSTOMER'), async (req, res) => {
    await db.query('DELETE FROM favorites WHERE user_id=$1 AND product_id=$2', [
      req.actor.id,
      uuid.parse(req.params.id),
    ]);
    res.status(204).end();
  });
  return r;
}
