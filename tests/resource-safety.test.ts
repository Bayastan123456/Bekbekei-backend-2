import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { OtpStore } from '../src/otp-store.js';
import { writeSse } from '../src/sse.js';
import { createLogger } from '../src/logger.js';

test('OTP cache expires without admin reads and has bounded capacity', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  const store = new OtpStore(2);
  try {
    store.set('first', { code: '1111', expiresAt: 1000 });
    store.set('second', { code: '2222', expiresAt: 1000 });
    store.set('third', { code: '3333', expiresAt: 1000 });
    assert.deepEqual(
      store.snapshot().map(entry => entry.phone),
      ['second', 'third'],
    );
    t.mock.timers.tick(30_000);
    // Inspect storage before snapshot(), which also prunes, to verify periodic cleanup.
    assert.equal((store as unknown as { entries: Map<string, unknown> }).entries.size, 0);
  } finally {
    store.close();
  }
});

test('SSE disconnects a blocked consumer and stops writing after disconnect', () => {
  let writes = 0;
  const response = {
    destroyed: false,
    writableEnded: false,
    write() {
      writes++;
      return false;
    },
    destroy() {
      this.destroyed = true;
    },
  };
  assert.equal(writeSse(response as unknown as ServerResponse, 'event'), false);
  assert.equal(response.destroyed, true);
  assert.equal(writeSse(response as unknown as ServerResponse, 'another event'), false);
  assert.equal(writes, 1);
});

test('logger removes inline credentials from errors including stack and cause', () => {
  const lines: string[] = [];
  const logger = createLogger('info', line => lines.push(line));
  const token = 'a'.repeat(64);
  logger({
    error: new Error(`password="private phrase" refresh_token=${token} postgres://username:dbpassword@localhost/db`, {
      cause: new Error('api_key=private-key&otp=1234'),
    }),
    password_hash: 'private-hash',
  });
  for (const secret of ['private phrase', token, 'username', 'dbpassword', 'private-key', '1234', 'private-hash'])
    assert.ok(!lines[0].includes(secret), secret);
  assert.match(JSON.parse(lines[0]).error.stack, /resource-safety.test.ts/);
});
