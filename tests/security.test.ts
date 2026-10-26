import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { assessmentFixture } from './assessment-helpers.js';
import { seedIds } from '../src/scripts/seed.js';
import { createOrder } from '../src/services/orders.js';
import type { Checkout } from '../src/schemas/orders.js';

let f: Awaited<ReturnType<typeof assessmentFixture>>;
let customer: Awaited<ReturnType<typeof f.actor>>, other: typeof customer, admin: typeof customer;
let addressId: string, threadId: string, orderId: string;
before(async () => {
  f = await assessmentFixture();
  customer = await f.actor();
  other = await f.actor();
  admin = await f.actor('ADMIN');
  const address = await f.call('/api/v1/me/addresses', customer.accessToken, {
    method: 'POST',
    body: JSON.stringify({ street: 'Assessment', latitude: 42.8746, longitude: 74.5698 }),
  });
  assert.equal(address.status, 201);
  addressId = (await address.json()).data.id;
  const thread = await f.call('/api/v1/support/threads', customer.accessToken, {
    method: 'POST',
    body: JSON.stringify({ message: 'private assessment message' }),
  });
  threadId = (await thread.json()).data.id;
  await f.call(`/api/v1/cart/items/${seedIds.lemon}`, customer.accessToken, {
    method: 'PUT',
    body: JSON.stringify({ storeId: seedIds.store, quantity: 1 }),
  });
  const body = { addressId, paymentMethod: 'CASH', courierComment: '', ageConfirmed: false } satisfies Checkout;
  const quote = await f.call('/api/v1/checkout/quote', customer.accessToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const result = await createOrder(f.db, customer.id, body, (await quote.json()).data.total, randomUUID(), 'mock');
  orderId = result.order.id;
});
after(async () => {
  if (f) await f.close();
});
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

test('security: protected routes deny missing and forged credentials', async () => {
  for (const path of ['/api/v1/me', '/api/v1/admin/orders', '/api/v1/support/threads', '/api/v1/events']) {
    assert.equal((await f.call(path)).status, 401);
    assert.equal((await f.call(path, 'forged-token')).status, 401);
  }
});
test('security: customers cannot read admin data or escalate roles', async () => {
  for (const path of ['/api/v1/admin/staff', '/api/v1/admin/otp-codes', '/api/v1/admin/audit', '/api/v1/admin/jobs'])
    assert.equal((await f.call(path, customer.accessToken)).status, 403);
  assert.equal(
    (
      await f.call('/api/v1/me', customer.accessToken, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'ADMIN', active: true }),
      })
    ).status,
    422,
  );
});
test('security: foreign addresses and orders cannot be read or modified', async () => {
  assert.equal((await f.call(`/api/v1/orders/${orderId}`, other.accessToken)).status, 404);
  assert.equal((await f.call(`/api/v1/orders/${orderId}/cancel`, other.accessToken, post({}))).status, 404);
  assert.equal(
    (await f.call(`/api/v1/me/addresses/${addressId}`, other.accessToken, { method: 'DELETE' })).status,
    404,
  );
  const response = await f.call('/api/v1/me/addresses', other.accessToken);
  assert.deepEqual((await response.json()).data, []);
});
test('security: support messages and status are isolated by owner and role', async () => {
  for (const options of [{}, post({ message: 'unauthorized change' })])
    assert.equal(
      (await f.call(`/api/v1/support/threads/${threadId}/messages`, other.accessToken, options)).status,
      404,
    );
  assert.equal(
    (
      await f.call(`/api/v1/support/threads/${threadId}`, customer.accessToken, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'CLOSED' }),
      })
    ).status,
    403,
  );
});
test('security: injection payloads fail validation without leaking SQL or stack traces', async () => {
  for (const payload of ["' OR 1=1--", "'; DROP TABLE users;--", '../.env']) {
    const response = await f.call(`/api/v1/orders/${encodeURIComponent(payload)}`, customer.accessToken);
    assert.equal(response.status, 422);
    const text = await response.text();
    assert.doesNotMatch(text, /SELECT |FROM users|at .*\.ts|password_hash/);
  }
  const response = await f.call(
    '/api/v1/auth/staff/login',
    undefined,
    post({ phone: "' OR 1=1--", password: 'anything' }),
  );
  assert.equal(response.status, 422);
});
test('security: malformed and oversized bodies are rejected', async () => {
  assert.equal(
    (await f.call('/api/v1/support/threads', customer.accessToken, { method: 'POST', body: '{invalid' })).status,
    400,
  );
  assert.equal(
    (await f.call('/api/v1/support/threads', customer.accessToken, post({ message: 'a'.repeat(70_000) }))).status,
    413,
  );
});
test('security: payment webhooks reject missing and forged signatures', async () => {
  for (const headers of [new Headers(), new Headers({ 'X-Payment-Signature': 'forged' })]) {
    const response = await f.call('/api/v1/webhooks/payments/mock', undefined, {
      ...post({ eventId: 'attack-event', paymentId: randomUUID(), amount: 0, status: 'PAID' }),
      headers,
    });
    assert.ok([400, 401].includes(response.status));
  }
});
test('security: credentials and private responses must not be cached', async () => {
  for (const path of ['/api/v1/me', '/api/v1/admin/otp-codes']) {
    const response = await f.call(path, admin.accessToken);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  }
  const response = await f.call('/api/v1/auth/refresh', undefined, post({ refreshToken: 'f'.repeat(64) }));
  assert.equal(response.status, 401);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
});
test('security: static routes do not expose environment, Git or source files', async () => {
  for (const path of ['/admin/.env', '/admin/.git/config', '/admin/%2e%2e/.env', '/admin/src/core.ts']) {
    const response = await f.call(path);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /OTP_SECRET|DATABASE_URL|\[core\]/);
  }
});
test('security: CORS rejects untrusted origins; Helmet sets browser protections', async () => {
  const response = await f.call('/health', undefined, { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(response.headers.get('content-security-policy'));
});
test('security: logout revokes access and refresh tokens', async () => {
  const actor = await f.actor();
  assert.equal((await f.call('/api/v1/auth/logout', actor.accessToken, { method: 'POST' })).status, 204);
  assert.equal((await f.call('/api/v1/me', actor.accessToken)).status, 401);
  assert.equal(
    (await f.call('/api/v1/auth/refresh', undefined, post({ refreshToken: actor.refreshToken }))).status,
    401,
  );
});
test('security: admin renders untrusted content through textContent', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML\(|\beval\(/);
});

test('security: malformed compressed bodies do not crash the HTTP server', async () => {
  const compressed = Buffer.concat([
    gzipSync(JSON.stringify({ message: 'compressed test' })),
    Buffer.from('invalid-trailer'),
  ]);
  const response = await f.call('/api/v1/support/threads', customer.accessToken, {
    method: 'POST',
    headers: { 'Content-Encoding': 'gzip' },
    body: new Uint8Array(compressed),
  });
  await response.arrayBuffer();
  assert.ok([201, 400].includes(response.status), `Unexpected compressed-body status ${response.status}`);
  assert.equal((await f.call('/health')).status, 200);
});
test('security: repeated password guesses trigger the auth rate limiter', async () => {
  const fixture = await assessmentFixture();
  try {
    const actor = await fixture.actor();
    const statuses = [];
    for (let n = 0; n < 35; n++) {
      const response = await fixture.call(
        '/api/v1/auth/staff/login',
        undefined,
        post({ phone: actor.phone, password: 'incorrect' }),
      );
      statuses.push(response.status);
      await response.arrayBuffer();
    }
    assert.equal(statuses.filter(status => status === 401).length, 30);
    assert.equal(statuses.filter(status => status === 429).length, 5);
  } finally {
    await fixture.close();
  }
});

test('security: compressed oversized data and unsupported encodings are bounded', async () => {
  const compressed = new Uint8Array(gzipSync(JSON.stringify({ message: 'a'.repeat(1_000_000) })));
  const response = await f.call('/api/v1/support/threads', customer.accessToken, {
    method: 'POST',
    headers: { 'Content-Encoding': 'gzip' },
    body: compressed,
  });
  assert.equal(response.status, 413);
  await response.arrayBuffer();
  const unsupported = await f.call('/api/v1/support/threads', customer.accessToken, {
    ...post({ message: 'encoding test' }),
    headers: { 'Content-Encoding': 'unsupported' },
  });
  assert.equal(unsupported.status, 415);
  await unsupported.arrayBuffer();
  assert.equal((await f.call('/health')).status, 200);
});
