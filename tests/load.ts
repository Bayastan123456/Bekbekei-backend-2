import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { assessmentFixture } from './assessment-helpers.js';
import { seedIds } from '../src/scripts/seed.js';
import { quote, createOrder } from '../src/services/orders.js';
import type { Checkout } from '../src/schemas/orders.js';

type Fixture = Awaited<ReturnType<typeof assessmentFixture>>;
type Actor = Awaited<ReturnType<Fixture['actor']>>;
const results: Record<string, unknown>[] = [];
const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    database: 'PGlite (serialized transactions, NOT a PostgreSQL concurrency benchmark)',
  },
  methodology:
    'Loopback HTTP only; separate seeded embedded database per scenario; closed-loop fixed worker counts; full response bodies consumed. Normal rate limits stay enabled; each scenario gets a fresh application and limiter. No external service or production data used. Latency excludes intentional client pacing delays.',
  results,
};
async function batch(
  name: string,
  count: number,
  concurrency: number,
  run: (index: number) => Promise<Response>,
  pacePerSecond?: number,
) {
  let next = 0,
    transportErrors = 0;
  const latency: number[] = [],
    statuses: Record<string, number> = {};
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < count) {
        const index = next++;
        if (pacePerSecond) {
          const wait = (index * 1000) / pacePerSecond - (performance.now() - started);
          if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        }
        const time = performance.now();
        try {
          const response = await run(index);
          await response.arrayBuffer();
          statuses[response.status] = (statuses[response.status] ?? 0) + 1;
        } catch {
          transportErrors++;
        }
        latency.push(performance.now() - time);
      }
    }),
  );
  const elapsedMs = performance.now() - started;
  loop.disable();
  latency.sort((a, b) => a - b);
  const percentile = (p: number) =>
    Number(latency[Math.min(latency.length - 1, Math.ceil(p * latency.length) - 1)].toFixed(2));
  const result = {
    name,
    count,
    concurrency,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    requestsPerSecond: Number(((count * 1000) / elapsedMs).toFixed(2)),
    latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: percentile(1) },
    eventLoopMaxMs: Number((loop.max / 1e6).toFixed(2)),
    statuses,
    transportErrors,
  };
  results.push(result);
  console.log(JSON.stringify(result));
  assert.equal(transportErrors, 0, `${name}: transport failures`);
  assert.equal(
    Object.entries(statuses).filter(([status]) => Number(status) >= 500).length,
    0,
    `${name}: server errors`,
  );
  return result;
}
async function scenario(run: (f: Fixture) => Promise<void>) {
  const fixture = await assessmentFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
async function checkout(f: Fixture, actor: Actor) {
  const id = randomUUID();
  await f.db.query('INSERT INTO addresses(id,user_id,street,latitude,longitude) VALUES($1,$2,$3,$4,$5)', [
    id,
    actor.id,
    'Load test',
    42.8746,
    74.5698,
  ]);
  await f.db.query('INSERT INTO carts(user_id,store_id) VALUES($1,$2)', [actor.id, seedIds.store]);
  await f.db.query('INSERT INTO cart_items(user_id,product_id,quantity) VALUES($1,$2,1)', [actor.id, seedIds.lemon]);
  const body = { addressId: id, paymentMethod: 'CASH', courierComment: '', ageConfirmed: false } satisfies Checkout;
  const pricing = await f.db.transaction(tx => quote(tx, actor.id, body));
  return { ...body, expectedTotal: pricing.total };
}

for (const concurrency of [1, 10, 25, 50])
  await scenario(async f => {
    for (let n = 0; n < 5; n++) await (await f.call(`/api/v1/products?storeId=${seedIds.store}`)).arrayBuffer();
    const result = await batch('catalog', 200, concurrency, () => f.call(`/api/v1/products?storeId=${seedIds.store}`));
    assert.equal(result.statuses[200], 200);
  });
await scenario(async f => {
  const actor = await f.actor();
  const result = await batch('authenticated profile reads', 200, 25, () => f.call('/api/v1/me', actor.accessToken));
  assert.equal(result.statuses[200], 200);
});
await scenario(async f => {
  const actor = await f.actor();
  const result = await batch('support thread writes', 100, 20, index =>
    f.call('/api/v1/support/threads', actor.accessToken, post({ message: `Load message ${index}` })),
  );
  assert.equal(result.statuses[201], 100);
  const { rows } = await f.db.query<{ count: number }>('SELECT count(*)::int count FROM support_threads');
  assert.equal(rows[0].count, 100);
});
await scenario(async f => {
  const actor = await f.actor();
  const result = await batch(
    'paced mixed traffic (20 requests/sec, 10 seconds)',
    200,
    20,
    index => {
      if (index % 4 === 0)
        return f.call('/api/v1/support/threads', actor.accessToken, post({ message: `Paced message ${index}` }));
      if (index % 4 === 1) return f.call('/api/v1/me', actor.accessToken);
      return f.call(`/api/v1/products?storeId=${seedIds.store}`);
    },
    20,
  );
  assert.equal(result.statuses[200], 150);
  assert.equal(result.statuses[201], 50);
});
await scenario(async f => {
  const actor = await f.actor(),
    body = await checkout(f, actor),
    key = randomUUID();
  const result = await batch('same checkout submitted 50 times', 50, 50, () =>
    f.call('/api/v1/orders', actor.accessToken, { ...post(body), headers: { 'Idempotency-Key': key } }),
  );
  assert.equal(result.statuses[201], 1);
  assert.equal(result.statuses[200], 49);
  const { rows } = await f.db.query<{ count: number }>('SELECT count(*)::int count FROM orders WHERE user_id=$1', [
    actor.id,
  ]);
  assert.equal(rows[0].count, 1);
  const stock = await f.db.query<{ reserved: number }>(
    'SELECT reserved FROM store_products WHERE store_id=$1 AND product_id=$2',
    [seedIds.store, seedIds.lemon],
  );
  assert.equal(stock.rows[0].reserved, 1);
});
await scenario(async f => {
  await f.db.query('UPDATE store_products SET stock=1,reserved=0 WHERE store_id=$1 AND product_id=$2', [
    seedIds.store,
    seedIds.lemon,
  ]);
  const attempts: { actor: Actor; body: Awaited<ReturnType<typeof checkout>> }[] = [];
  for (let n = 0; n < 20; n++) {
    const actor = await f.actor();
    attempts.push({ actor, body: await checkout(f, actor) });
  }
  const result = await batch('20 customers contend for last item', 20, 20, index => {
    const { actor, body } = attempts[index];
    return f.call('/api/v1/orders', actor.accessToken, { ...post(body), headers: { 'Idempotency-Key': randomUUID() } });
  });
  assert.equal(result.statuses[201], 1);
  assert.equal(result.statuses[409], 19);
  const { rows } = await f.db.query<{ stock: number; reserved: number }>(
    'SELECT stock,reserved FROM store_products WHERE store_id=$1 AND product_id=$2',
    [seedIds.store, seedIds.lemon],
  );
  assert.deepEqual(rows[0], { stock: 1, reserved: 1 });
});
await scenario(async f => {
  const customer = await f.actor(),
    { expectedTotal, ...body } = await checkout(f, customer);
  const { order } = await createOrder(f.db, customer.id, body, expectedTotal, randomUUID(), 'mock');
  const pickers: Actor[] = [];
  for (let n = 0; n < 20; n++) pickers.push(await f.actor('PICKER'));
  const result = await batch('20 pickers contend for one order', 20, 20, index =>
    f.call(`/api/v1/picking/tasks/${order.id}/claim`, pickers[index].accessToken, post({})),
  );
  assert.equal(result.statuses[200], 1);
  assert.equal(result.statuses[409], 19);
});
await scenario(async f => {
  const result = await batch('per-IP rate limit burst', 350, 50, () => f.call('/health'));
  assert.equal(result.statuses[200], 300);
  assert.equal(result.statuses[429], 50);
});
await scenario(async f => {
  const actor = await f.actor();
  for (let cycle = 0; cycle < 10; cycle++) {
    const streams = await Promise.all(Array.from({ length: 3 }, () => f.call('/api/v1/events', actor.accessToken)));
    for (const stream of streams) assert.equal(stream.status, 200);
    const denied = await f.call('/api/v1/events', actor.accessToken);
    assert.equal(denied.status, 429);
    await denied.arrayBuffer();
    for (const stream of streams) await stream.body!.cancel();
    // Probe until the server observes closed sockets (bounded, no fixed long sleep).
    let probe: Response | undefined;
    for (let retry = 0; retry < 20; retry++) {
      probe = await f.call('/api/v1/events', actor.accessToken);
      if (probe.status === 200) break;
      await probe.arrayBuffer();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(probe?.status, 200, 'SSE connection slots were not released');
    await probe.body!.cancel();
  }
  results.push({ name: 'SSE reconnect cleanup', cycles: 10, maxStreamsPerUser: 3, passed: true });
});
await writeFile(new URL('../docs/LOAD_TEST_RESULTS.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log('All local load scenarios passed. Report: docs/LOAD_TEST_RESULTS.json');
