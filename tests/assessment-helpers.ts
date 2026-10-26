import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { newSession } from '../src/modules/auth.js';
import { seed, seedIds } from '../src/scripts/seed.js';
import { migrate } from '../src/scripts/migrate.js';
import { type Config } from '../src/core.js';
import { testDatabase } from './database.js';

export async function assessmentFixture() {
  // Always embedded/local. Never load DATABASE_URL or use a deployed API.
  const db = await testDatabase('');
  await migrate(db);
  await seed(db);
  await db.query("UPDATE stores SET opens_at='00:00',closes_at='00:00'");
  const logs: Record<string, unknown>[] = [];
  const cfg: Config = {
    env: 'test',
    otpSecret: 'assessment-secret-not-for-deployment',
    webhookSecret: 'assessment-webhook-not-for-deployment',
    smsProvider: 'log',
    paymentProvider: 'mock',
    corsOrigins: ['https://allowed.example'],
    logger: data => {
      if (logs.length < 1000) logs.push(data);
    },
  };
  const app = createApp(db, cfg);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local HTTP address');
  const base = `http://127.0.0.1:${address.port}`;
  let number = 800000000;
  async function actor(role = 'CUSTOMER') {
    const id = randomUUID(),
      phone = `+996${++number}`;
    await db.query('INSERT INTO users(id,phone,role) VALUES($1,$2,$3)', [id, phone, role]);
    if (role !== 'CUSTOMER')
      await db.query('INSERT INTO staff_stores(user_id,store_id) VALUES($1,$2)', [id, seedIds.store]);
    return { id, phone, role, ...(await newSession(db, id)) };
  }
  async function call(path: string, accessToken?: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    return fetch(`${base}${path}`, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(15_000),
      headers,
    });
  }

  async function close() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    await db.close();
  }
  return { db, app, server, cfg, base, logs, actor, call, close };
}
