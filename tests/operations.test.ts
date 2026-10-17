import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import request from 'supertest';
import { testDatabase } from './database.js';
import { migrate } from '../src/scripts/migrate.js';
import { one, type Database } from '../src/db.js';
import { cleanupTechnicalData, jobHealth } from '../src/services/maintenance.js';
import { Lifecycle, shutdownServer } from '../src/lifecycle.js';
import { createApp } from '../src/app.js';
import { newSession } from '../src/modules/auth.js';
import { runJobs, startWorker } from '../src/worker.js';
import type { Config } from '../src/core.js';

let db: Database;
const cfg: Config = {
  env: 'test',
  otpSecret: 'test-secret',
  webhookSecret: 'test-secret',
  smsProvider: 'log',
  paymentProvider: 'mock',
  corsOrigins: [],
  logger: () => {},
};
before(async () => {
  db = await testDatabase();
  await migrate(db);
});
after(async () => {
  await db.close();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

test('очистка ограничена размером пачки и сохраняет незавершённые задачи и свежие записи', async () => {
  for (let n = 0; n < 3; n++)
    await db.query("INSERT INTO events(type,payload,created_at) VALUES('old','{}',now()-interval '8 days')");
  await db.query("INSERT INTO events(type,payload) VALUES('fresh','{}')");
  const userId = randomUUID(),
    expired = randomUUID(),
    active = randomUUID(),
    revoked = randomUUID();
  await db.query('INSERT INTO users(id,phone) VALUES($1,$2)', [userId, '+996700000000']);
  for (const id of [expired, active, revoked]) {
    await db.query(
      `INSERT INTO sessions(id,user_id,access_hash,refresh_hash,access_expires_at,refresh_expires_at)
      VALUES($1,$2,$3,$3,now()+interval '1 day',now()+interval '1 day')`,
      [id, userId, id],
    );
  }
  await db.query("UPDATE sessions SET refresh_expires_at=now()-interval '31 days' WHERE id=$1", [expired]);
  await db.query("UPDATE sessions SET revoked_at=now()-interval '31 days' WHERE id=$1", [revoked]);
  await db.query(
    "INSERT INTO otp_challenges(phone,code_hash,expires_at,retry_at) VALUES('old','hash',now()-interval '2 days',now()),('fresh','hash',now()+interval '5 minutes',now())",
  );
  const completed = randomUUID(),
    failed = randomUUID(),
    pending = randomUUID();
  await db.query(
    `INSERT INTO jobs(id,kind,payload,run_at,completed_at,attempts) VALUES
    ($1,'TEST','{}',now(),now()-interval '31 days',1),
    ($2,'TEST','{}',now()-interval '40 days',NULL,10),
    ($3,'TEST','{}',now()+interval '1 day',NULL,0)`,
    [completed, failed, pending],
  );
  const first = await cleanupTechnicalData(db, 2);
  assert.deepEqual(first, { events: 2, sessions: 2, otp_challenges: 1, jobs: 1 });
  assert.equal((await one<{ count: number }>(db, "SELECT count(*)::int count FROM events WHERE type='old'"))!.count, 1);
  await cleanupTechnicalData(db, 2);
  assert.equal((await one<{ count: number }>(db, 'SELECT count(*)::int count FROM events'))!.count, 1);
  assert.ok(await one(db, 'SELECT 1 FROM sessions WHERE id=$1', [active]));
  assert.ok(await one(db, "SELECT 1 FROM otp_challenges WHERE phone='fresh'"));
  assert.equal(
    (await one<{ count: number }>(db, 'SELECT count(*)::int count FROM jobs WHERE id=ANY($1::uuid[])', [
      [failed, pending],
    ]))!.count,
    2,
  );
  await assert.rejects(cleanupTechnicalData(db, 0));
});

test('мониторинг различает исчерпанные попытки, просроченные, будущие и завершённые задачи', async () => {
  await db.query('DELETE FROM jobs');
  const ids = Array.from({ length: 4 }, () => randomUUID());
  await db.query(
    `INSERT INTO jobs(id,kind,payload,run_at,attempts,completed_at) VALUES
    ($1,'TEST','{}',now()-interval '1 hour',10,NULL),
    ($2,'TEST','{}',now()-interval '10 minutes',1,NULL),
    ($3,'TEST','{}',now()+interval '1 hour',0,NULL),
    ($4,'TEST','{}',now()-interval '1 hour',1,now())`,
    ids,
  );
  const health = await jobHealth(db);
  assert.equal(health.failed, 1);
  assert.equal(health.overdue, 1);
  assert.ok(health.oldestDueAt);
  const summary = await request(createApp(db, cfg)).get('/api/v1/admin/summary');
  assert.equal(summary.status, 401);
});

test('повреждённый payload известной задачи сохраняет ошибку для повторной обработки', async () => {
  await db.query('DELETE FROM jobs');
  const id = randomUUID();
  await db.query("INSERT INTO jobs(id,kind,payload,run_at) VALUES($1,'EXPIRE_ORDER','{}',now())", [id]);
  await runJobs(db, cfg, 1);
  const job = await one<{ attempts: number; completed_at: Date | null; last_error: string }>(
    db,
    'SELECT attempts,completed_at,last_error FROM jobs WHERE id=$1',
    [id],
  );
  assert.equal(job!.attempts, 1);
  assert.equal(job!.completed_at, null);
  assert.match(job!.last_error, /orderId/);
});

test('readiness сообщает 503 во время остановки', async () => {
  const lifecycle = new Lifecycle();
  const app = createApp(db, cfg, lifecycle);
  assert.equal((await request(app).get('/ready')).status, 200);
  lifecycle.drain();
  const response = await request(app).get('/ready');
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'SHUTTING_DOWN');
});

test('остановка закрывает SSE, дожидается HTTP и воркера, затем закрывает БД', async () => {
  const lifecycle = new Lifecycle();
  const started = deferred(),
    responseAllowed = deferred(),
    workerAllowed = deferred();
  let dbClosed = false;
  const server = createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
      lifecycle.registerStream(res);
    } else {
      started.resolve();
      void responseAllowed.promise.then(() => res.end('finished'));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const stream = await fetch(`${base}/events`);
    const streamBody = stream.text();
    const slow = fetch(`${base}/slow`);
    await started.promise;
    const stopped = shutdownServer(
      server,
      lifecycle,
      () => workerAllowed.promise,
      {
        close: () => {
          dbClosed = true;
          return Promise.resolve();
        },
      },
      () => assert.fail('shutdown timed out'),
    );
    assert.equal(lifecycle.draining, true);
    assert.match(await streamBody, /connected/);
    assert.equal(dbClosed, false);
    responseAllowed.resolve();
    assert.equal(await (await slow).text(), 'finished');
    assert.equal(dbClosed, false);
    workerAllowed.resolve();
    await stopped;
    assert.equal(dbClosed, true);
  } finally {
    responseAllowed.resolve();
    workerAllowed.resolve();
    server.closeAllConnections();
    server.close();
  }
});

test('stopWorker ожидает текущую транзакцию и больше не запускает обработку', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const entered = deferred(),
    allowed = deferred();
  let calls = 0,
    stopped = false;
  const delayedDb: Database = {
    ...db,
    transaction: async fn => {
      calls++;
      entered.resolve();
      await allowed.promise;
      return db.transaction(fn);
    },
  };
  const stop = startWorker(delayedDb, cfg);
  context.mock.timers.tick(2000);
  await entered.promise;
  const stopping = stop().then(() => {
    stopped = true;
  });
  try {
    await setImmediate();
    assert.equal(stopped, false);
    allowed.resolve();
    await stopping;
    assert.equal(calls, 1);
    const previousCalls = calls;
    context.mock.timers.tick(10_000);
    await setImmediate();
    assert.equal(calls, previousCalls);
  } finally {
    allowed.resolve();
    await stopping;
  }
});

test('таймаут остановки вызывает аварийный обработчик до закрытия БД', async () => {
  const lifecycle = new Lifecycle(),
    workerAllowed = deferred(),
    timedOut = deferred();
  let dbClosed = false;
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const stopped = shutdownServer(
    server,
    lifecycle,
    () => workerAllowed.promise,
    {
      close: () => {
        dbClosed = true;
        return Promise.resolve();
      },
    },
    () => timedOut.resolve(),
    20,
  );
  try {
    await timedOut.promise;
    assert.equal(dbClosed, false);
    workerAllowed.resolve();
    await stopped;
    assert.equal(dbClosed, true);
  } finally {
    workerAllowed.resolve();
    await stopped;
    server.closeAllConnections();
    server.close();
  }
});

test('SSE сообщает об истёкшей истории и закрывается при draining', async () => {
  const id = randomUUID();
  await db.query('INSERT INTO users(id,phone) VALUES($1,$2)', [id, '+996700000001']);
  const session = await newSession(db, id);
  await db.query('DELETE FROM events');
  await db.query("INSERT INTO events(type,payload) VALUES('retained','{}')");
  const lifecycle = new Lifecycle();
  const server = createApp(db, cfg, lifecycle).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/events?after=1`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('HISTORY_EXPIRED')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(text, /event: stream.reset/);
    lifecycle.drain();
    while (!(await reader.read()).done) {
      /* Drain the final response bytes. */
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
});
