import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, type Database, type SQL } from '../db.js';
import { assert, money, page, passwordHash, phone, uuid, type Config } from '../core.js';
import { authentication, devOtpSnapshot, roles } from './auth.js';
import { cancelOrder, orderDetail, setStatus } from './orders.js';

export const localized = z
  .object({ ru: z.string().min(1).max(5000), ky: z.string().max(5000).optional(), en: z.string().max(5000).optional() })
  .strict();
const optionalLocalized = z
  .object({
    ru: z.string().max(5000).optional(),
    ky: z.string().max(5000).optional(),
    en: z.string().max(5000).optional(),
  })
  .strict();
const imageUrl = z
  .url()
  .refine(v => v.startsWith('https://'), 'Изображение должно иметь HTTPS URL')
  .nullable()
  .optional();
const productSchema = z
  .object({
    categoryId: uuid,
    name: localized,
    description: optionalLocalized.default({}),
    composition: optionalLocalized.default({}),
    nutrition: z
      .object({
        calories: z.number().min(0).max(10000).optional(),
        protein: z.number().min(0).max(1000).optional(),
        fat: z.number().min(0).max(1000).optional(),
        carbohydrates: z.number().min(0).max(1000).optional(),
      })
      .strict()
      .default({}),
    unit: z.string().min(1).max(60),
    imageUrl,
    isNew: z.boolean().default(false),
    ageRestricted: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  .strict();
const storeSchema = z
  .object({
    name: z.string().min(1).max(150),
    address: z.string().min(3).max(300),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    radiusKm: z.number().positive().max(100),
    deliveryFee: money,
    minimumOrder: money.default(0),
    opensAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    closesAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    active: z.boolean().default(true),
  })
  .strict();
async function audit(tx: SQL, userId: string, action: string, id: string, payload: unknown = {}) {
  await tx.query('INSERT INTO audit_logs(actor_id,action,entity_id,payload) VALUES($1,$2,$3,$4)', [
    userId,
    action,
    id,
    JSON.stringify(payload),
  ]);
}
export function adminRoutes(db: Database, cfg: Config) {
  const r = Router();
  r.use(authentication(db), roles('ADMIN'));
  r.get('/otp-codes', (_req, res) => {
    assert(cfg.env !== 'production', 404, 'NOT_FOUND', 'Недоступно');
    res.json({ data: devOtpSnapshot() });
  });
  r.get('/summary', async (_req, res) =>
    res.json({
      data: {
        orders: (await db.query('SELECT status,count(*)::int count FROM orders GROUP BY status')).rows,
        lowStock: (
          await db.query(
            'SELECT sp.*,p.name FROM store_products sp JOIN products p ON p.id=sp.product_id WHERE stock-reserved<5 ORDER BY stock-reserved LIMIT 50',
          )
        ).rows,
        failedJobs: (
          await db.query('SELECT id,kind,attempts,last_error FROM jobs WHERE completed_at IS NULL AND attempts>=10')
        ).rows,
      },
    }),
  );
  r.get('/orders', async (req, res) => {
    const p = page(req.query);
    const status = z
      .enum([
        'AWAITING_PAYMENT',
        'CONFIRMED',
        'PICKING',
        'READY',
        'DELIVERING',
        'DELIVERED',
        'CANCELLED',
        'RETURNING',
        'RETURNED',
      ])
      .optional()
      .parse(req.query.status);
    res.json({
      data: (
        await db.query(
          'SELECT * FROM orders WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC LIMIT $2 OFFSET $3',
          [status ?? null, p.limit, p.offset],
        )
      ).rows,
    });
  });
  r.get('/orders/:id', async (req, res) =>
    res.json({ data: await orderDetail(db, uuid.parse((req.params as Record<string, string>).id)) }),
  );
  r.post('/orders/:id/cancel', async (req, res) => {
    const id = uuid.parse((req.params as Record<string, string>).id);
    await db.transaction(async tx => {
      const o = await one(tx, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
      assert(o, 404, 'NOT_FOUND', 'Заказ не найден');
      if (o.status !== 'CANCELLED') await cancelOrder(tx, o, req.actor.id);
      await audit(tx, req.actor.id, 'CANCEL_ORDER', id);
    });
    res.json({ data: await orderDetail(db, id) });
  });
  r.post('/orders/:id/authorize-return', async (req, res) => {
    const id = uuid.parse((req.params as Record<string, string>).id);
    await db.transaction(async tx => {
      const o = await one(tx, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
      assert(o, 404, 'NOT_FOUND', 'Заказ не найден');
      assert(o.status === 'DELIVERING', 409, 'INVALID_STATE', 'Заказ не в доставке');
      assert(
        o.payment_method !== 'CASH' || o.payment_status !== 'PAID',
        409,
        'CASH_REFUND_UNSUPPORTED',
        'Сначала оформите возврат наличных вне приложения',
      );
      await setStatus(tx, o, 'RETURNING', req.actor.id);
      await audit(tx, req.actor.id, 'AUTHORIZE_RETURN', id);
    });
    res.status(204).end();
  });
  r.get('/stores', async (_req, res) =>
    res.json({ data: (await db.query('SELECT * FROM stores ORDER BY name')).rows }),
  );
  for (const method of ['post', 'put'] as const)
    r[method](method === 'post' ? '/stores' : '/stores/:id', async (req, res) => {
      const b = storeSchema.parse(req.body),
        id = method === 'post' ? randomUUID() : uuid.parse((req.params as Record<string, string>).id);
      const row = await db.transaction(async tx => {
        const s =
          method === 'post'
            ? await one(
                tx,
                'INSERT INTO stores(id,name,address,latitude,longitude,radius_km,delivery_fee,minimum_order,opens_at,closes_at,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
                [
                  id,
                  b.name,
                  b.address,
                  b.latitude,
                  b.longitude,
                  b.radiusKm,
                  b.deliveryFee,
                  b.minimumOrder,
                  b.opensAt,
                  b.closesAt,
                  b.active,
                ],
              )
            : await one(
                tx,
                'UPDATE stores SET name=$2,address=$3,latitude=$4,longitude=$5,radius_km=$6,delivery_fee=$7,minimum_order=$8,opens_at=$9,closes_at=$10,active=$11 WHERE id=$1 RETURNING *',
                [
                  id,
                  b.name,
                  b.address,
                  b.latitude,
                  b.longitude,
                  b.radiusKm,
                  b.deliveryFee,
                  b.minimumOrder,
                  b.opensAt,
                  b.closesAt,
                  b.active,
                ],
              );
        assert(s, 404, 'NOT_FOUND', 'Магазин не найден');
        await audit(tx, req.actor.id, 'SAVE_STORE', id);
        return s;
      });
      res.status(method === 'post' ? 201 : 200).json({ data: row });
    });
  r.get('/categories', async (_req, res) =>
    res.json({ data: (await db.query('SELECT * FROM categories ORDER BY sort')).rows }),
  );
  for (const method of ['post', 'put'] as const)
    r[method](method === 'post' ? '/categories' : '/categories/:id', async (req, res) => {
      const b = z
          .object({ name: localized, sort: z.number().int().min(0).max(10000).default(0) })
          .strict()
          .parse(req.body),
        id = method === 'post' ? randomUUID() : uuid.parse((req.params as Record<string, string>).id);
      const row = await db.transaction(async tx => {
        const c =
          method === 'post'
            ? await one(tx, 'INSERT INTO categories(id,name,sort) VALUES($1,$2,$3) RETURNING *', [
                id,
                JSON.stringify(b.name),
                b.sort,
              ])
            : await one(tx, 'UPDATE categories SET name=$2,sort=$3 WHERE id=$1 RETURNING *', [
                id,
                JSON.stringify(b.name),
                b.sort,
              ]);
        assert(c, 404, 'NOT_FOUND', 'Категория не найдена');
        await audit(tx, req.actor.id, 'SAVE_CATEGORY', id);
        return c;
      });
      res.status(method === 'post' ? 201 : 200).json({ data: row });
    });
  r.get('/products', async (req, res) => {
    const p = page(req.query);
    res.json({
      data: (await db.query('SELECT * FROM products ORDER BY created_at DESC LIMIT $1 OFFSET $2', [p.limit, p.offset]))
        .rows,
    });
  });
  for (const method of ['post', 'put'] as const)
    r[method](method === 'post' ? '/products' : '/products/:id', async (req, res) => {
      const b = productSchema.parse(req.body),
        id = method === 'post' ? randomUUID() : uuid.parse((req.params as Record<string, string>).id);
      const row = await db.transaction(async tx => {
        assert(
          await one(tx, 'SELECT id FROM categories WHERE id=$1', [b.categoryId]),
          422,
          'CATEGORY_NOT_FOUND',
          'Категория не найдена',
        );
        const args = [
          id,
          b.categoryId,
          JSON.stringify(b.name),
          JSON.stringify(b.description),
          JSON.stringify(b.composition),
          JSON.stringify(b.nutrition),
          b.unit,
          b.imageUrl ?? null,
          b.isNew,
          b.ageRestricted,
          b.active,
        ];
        const p =
          method === 'post'
            ? await one(
                tx,
                'INSERT INTO products(id,category_id,name,description,composition,nutrition,unit,image_url,is_new,age_restricted,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
                args,
              )
            : await one(
                tx,
                'UPDATE products SET category_id=$2,name=$3,description=$4,composition=$5,nutrition=$6,unit=$7,image_url=$8,is_new=$9,age_restricted=$10,active=$11 WHERE id=$1 RETURNING *',
                args,
              );
        assert(p, 404, 'NOT_FOUND', 'Товар не найден');
        await audit(tx, req.actor.id, 'SAVE_PRODUCT', id);
        return p;
      });
      res.status(method === 'post' ? 201 : 200).json({ data: row });
    });
  r.get('/inventory', async (req, res) => {
    const p = page(req.query);
    res.json({
      data: (
        await db.query(
          'SELECT sp.*,p.name FROM store_products sp JOIN products p ON p.id=sp.product_id ORDER BY sp.store_id,sp.product_id LIMIT $1 OFFSET $2',
          [p.limit, p.offset],
        )
      ).rows,
    });
  });
  r.put('/inventory', async (req, res) => {
    const b = z
      .object({ storeId: uuid, productId: uuid, price: money, stock: z.number().int().min(0).max(1000000) })
      .strict()
      .parse(req.body);
    await db.transaction(async tx => {
      assert(
        await one(tx, 'SELECT id FROM stores WHERE id=$1', [b.storeId]),
        422,
        'STORE_NOT_FOUND',
        'Магазин не найден',
      );
      assert(
        await one(tx, 'SELECT id FROM products WHERE id=$1', [b.productId]),
        422,
        'PRODUCT_NOT_FOUND',
        'Товар не найден',
      );
      const result = await tx.query(
        'INSERT INTO store_products(store_id,product_id,price,stock) VALUES($1,$2,$3,$4) ON CONFLICT(store_id,product_id) DO UPDATE SET price=excluded.price,stock=excluded.stock WHERE store_products.reserved<=excluded.stock RETURNING *',
        [b.storeId, b.productId, b.price, b.stock],
      );
      assert(result.rowCount, 409, 'RESERVED_STOCK', 'Нельзя установить остаток ниже зарезервированного');
      await audit(tx, req.actor.id, 'UPDATE_INVENTORY', b.productId, b);
    });
    res.status(204).end();
  });
  r.get('/staff', async (_req, res) =>
    res.json({
      data: (
        await db.query(
          "SELECT u.id,u.phone,u.role,u.first_name,u.last_name,u.active,COALESCE(jsonb_agg(ss.store_id) FILTER(WHERE ss.store_id IS NOT NULL),'[]') store_ids FROM users u LEFT JOIN staff_stores ss ON ss.user_id=u.id WHERE u.role<>'CUSTOMER' GROUP BY u.id ORDER BY u.created_at",
        )
      ).rows,
    }),
  );
  r.post('/staff', async (req, res) => {
    const b = z
      .object({
        phone,
        password: z.string().min(12).max(128),
        role: z.enum(['PICKER', 'COURIER', 'ADMIN']),
        firstName: z.string().min(1).max(80),
        lastName: z.string().max(80).default(''),
        storeIds: z.array(uuid).min(1).max(100),
      })
      .strict()
      .parse(req.body);
    const id = randomUUID();
    await db.transaction(async tx => {
      assert(
        !(await one(tx, 'SELECT 1 FROM users WHERE phone=$1', [b.phone])),
        409,
        'PHONE_EXISTS',
        'Телефон уже используется',
      );
      await tx.query('INSERT INTO users(id,phone,password_hash,role,first_name,last_name) VALUES($1,$2,$3,$4,$5,$6)', [
        id,
        b.phone,
        passwordHash(b.password),
        b.role,
        b.firstName,
        b.lastName,
      ]);
      for (const storeId of new Set(b.storeIds)) {
        assert(
          await one(tx, 'SELECT id FROM stores WHERE id=$1', [storeId]),
          422,
          'STORE_NOT_FOUND',
          'Магазин не найден',
        );
        await tx.query('INSERT INTO staff_stores(user_id,store_id) VALUES($1,$2)', [id, storeId]);
      }
      await audit(tx, req.actor.id, 'CREATE_STAFF', id, { role: b.role });
    });
    res.status(201).json({ data: { id, phone: b.phone, role: b.role } });
  });
  r.patch('/staff/:id', async (req, res) => {
    const id = uuid.parse((req.params as Record<string, string>).id),
      b = z
        .object({
          active: z.boolean().optional(),
          password: z.string().min(12).max(128).optional(),
          storeIds: z.array(uuid).min(1).max(100).optional(),
        })
        .strict()
        .parse(req.body);
    assert(
      id !== req.actor.id,
      422,
      'SELF_MODIFICATION',
      'Изменение собственной административной учётной записи здесь запрещено',
    );
    await db.transaction(async tx => {
      const user = await one(tx, "SELECT id FROM users WHERE id=$1 AND role<>'CUSTOMER' FOR NO KEY UPDATE", [id]);
      assert(user, 404, 'NOT_FOUND', 'Сотрудник не найден');
      await tx.query(
        'UPDATE users SET active=COALESCE($2,active),password_hash=COALESCE($3,password_hash) WHERE id=$1',
        [id, b.active ?? null, b.password ? passwordHash(b.password) : null],
      );
      if (b.storeIds) {
        await tx.query('DELETE FROM staff_stores WHERE user_id=$1', [id]);
        for (const storeId of new Set(b.storeIds)) {
          assert(
            await one(tx, 'SELECT id FROM stores WHERE id=$1', [storeId]),
            422,
            'STORE_NOT_FOUND',
            'Магазин не найден',
          );
          await tx.query('INSERT INTO staff_stores(user_id,store_id) VALUES($1,$2)', [id, storeId]);
        }
      }
      await tx.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [id]);
      await audit(tx, req.actor.id, 'UPDATE_STAFF', id, { active: b.active });
    });
    res.status(204).end();
  });
  r.get('/promotions', async (_req, res) =>
    res.json({ data: (await db.query('SELECT * FROM promotions ORDER BY starts_at DESC')).rows }),
  );
  r.post('/promotions', async (req, res) => {
    const b = z
      .object({
        code: z
          .string()
          .min(1)
          .max(40)
          .regex(/^[A-Z0-9_-]+$/),
        kind: z.enum(['PERCENT', 'FIXED', 'FREE_DELIVERY', 'GIFT']),
        value: money.default(0),
        minimumOrder: money.default(0),
        startsAt: z.iso.datetime(),
        endsAt: z.iso.datetime(),
        usageLimit: z.number().int().min(1).max(1000000),
        giftProductId: uuid.optional(),
        triggerProductIds: z.array(uuid).max(100).default([]),
      })
      .strict()
      .parse(req.body);
    assert(
      +new Date(b.endsAt) > +new Date(b.startsAt),
      422,
      'INVALID_DATES',
      'Дата окончания должна быть позже начала',
    );
    assert(b.kind !== 'PERCENT' || b.value <= 100, 422, 'INVALID_PERCENT', 'Процент не больше 100');
    assert(
      b.kind !== 'GIFT' || (b.giftProductId && b.triggerProductIds.length),
      422,
      'INVALID_GIFT',
      'Укажите подарок и товары-условия',
    );
    await db.transaction(async tx => {
      await tx.query(
        'INSERT INTO promotions(code,kind,value,minimum_order,starts_at,ends_at,usage_limit,gift_product_id,trigger_product_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          b.code,
          b.kind,
          b.value,
          b.minimumOrder,
          b.startsAt,
          b.endsAt,
          b.usageLimit,
          b.giftProductId ?? null,
          JSON.stringify(b.triggerProductIds),
        ],
      );
      await audit(tx, req.actor.id, 'CREATE_PROMOTION', b.code);
    });
    res.status(201).json({ data: { code: b.code } });
  });
  r.patch('/promotions/:code', async (req, res) => {
    const b = z.object({ active: z.boolean() }).strict().parse(req.body);
    const code = z.string().max(40).parse(req.params.code);
    await db.transaction(async tx => {
      const p = await one(tx, 'UPDATE promotions SET active=$2 WHERE code=$1 RETURNING code', [code, b.active]);
      assert(p, 404, 'NOT_FOUND', 'Промокод не найден');
      await audit(tx, req.actor.id, 'TOGGLE_PROMOTION', code, b);
    });
    res.status(204).end();
  });
  r.get('/content', async (_req, res) =>
    res.json({ data: (await db.query('SELECT * FROM content ORDER BY sort,id')).rows }),
  );
  for (const method of ['post', 'put'] as const)
    r[method](method === 'post' ? '/content' : '/content/:id', async (req, res) => {
      const b = z
          .object({
            kind: z.enum(['BANNER', 'STORY', 'NOTICE', 'DOCUMENT', 'COLLECTION']),
            title: localized,
            body: optionalLocalized.default({}),
            imageUrl,
            productIds: z.array(uuid).max(100).default([]),
            active: z.boolean().default(true),
            sort: z.number().int().min(0).max(10000).default(0),
          })
          .strict()
          .parse(req.body),
        id = method === 'post' ? randomUUID() : uuid.parse((req.params as Record<string, string>).id);
      const row = await db.transaction(async tx => {
        const args = [
          id,
          b.kind,
          JSON.stringify(b.title),
          JSON.stringify(b.body),
          b.imageUrl ?? null,
          JSON.stringify(b.productIds),
          b.active,
          b.sort,
        ];
        const c =
          method === 'post'
            ? await one(
                tx,
                'INSERT INTO content(id,kind,title,body,image_url,product_ids,active,sort) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
                args,
              )
            : await one(
                tx,
                'UPDATE content SET kind=$2,title=$3,body=$4,image_url=$5,product_ids=$6,active=$7,sort=$8 WHERE id=$1 RETURNING *',
                args,
              );
        assert(c, 404, 'NOT_FOUND', 'Контент не найден');
        await audit(tx, req.actor.id, 'SAVE_CONTENT', id);
        return c;
      });
      res.status(method === 'post' ? 201 : 200).json({ data: row });
    });
  r.get('/refunds', async (req, res) => {
    const p = page(req.query);
    res.json({
      data: (await db.query('SELECT * FROM refunds ORDER BY created_at DESC LIMIT $1 OFFSET $2', [p.limit, p.offset]))
        .rows,
    });
  });
  r.get('/payments', async (req, res) => {
    const p = page(req.query);
    res.json({
      data: (await db.query('SELECT * FROM payments ORDER BY created_at DESC LIMIT $1 OFFSET $2', [p.limit, p.offset]))
        .rows,
    });
  });
  r.get('/jobs', async (req, res) => {
    const p = page(req.query);
    res.json({
      data: (await db.query('SELECT * FROM jobs ORDER BY run_at DESC LIMIT $1 OFFSET $2', [p.limit, p.offset])).rows,
    });
  });
  r.post('/jobs/:id/retry', async (req, res) => {
    const id = uuid.parse((req.params as Record<string, string>).id);
    await db.transaction(async tx => {
      const j = await one(
        tx,
        'UPDATE jobs SET attempts=0,run_at=now(),last_error=NULL WHERE id=$1 AND completed_at IS NULL RETURNING id',
        [id],
      );
      assert(j, 404, 'NOT_FOUND', 'Незавершённая задача не найдена');
      await audit(tx, req.actor.id, 'RETRY_JOB', id);
    });
    res.status(204).end();
  });
  r.get('/audit', async (req, res) => {
    const p = page(req.query);
    res.json({
      data: (await db.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT $1 OFFSET $2', [p.limit, p.offset])).rows,
    });
  });
  return r;
}
