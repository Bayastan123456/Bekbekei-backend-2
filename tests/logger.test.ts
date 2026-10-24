import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createLogger } from '../src/logger.js';
import { createApp } from '../src/app.js';
import type { Config } from '../src/core.js';
import type { Database } from '../src/db.js';

test('logger preserves stack, redacts secrets recursively and filters levels', () => {
  const lines: string[] = [];
  const log = createLogger('warn', line => lines.push(line));
  log({ type: 'ignored', level: 'info' });
  const error = new Error('failed for +996555123456');
  log({
    type: 'failure',
    level: 'error',
    error,
    nested: { password: 'secret', accessToken: 'token', phone: '+996555123456', code: '1234' },
  });
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, 'error');
  assert.ok(Number.isFinite(Date.parse(entry.timestamp)));
  assert.match(entry.error.stack, /logger.test.ts/);
  assert.ok(!lines[0].includes('+996555123456'));
  for (const value of Object.values(entry.nested)) assert.equal(value, '[REDACTED]');
  assert.throws(() => createLogger('invalid'), /LOG_LEVEL/);
});

test('HTTP logs correlate errors and omit query, body and concrete paths', async () => {
  const entries: Record<string, any>[] = [];
  const cfg: Config = {
    env: 'test',
    otpSecret: '',
    webhookSecret: '',
    smsProvider: 'log',
    paymentProvider: 'mock',
    corsOrigins: [],
    logger: data => entries.push(data),
  };
  const failure = new Error('database unavailable');
  const db = { query: () => Promise.reject(failure) } as unknown as Database;
  const app = createApp(db, cfg);
  const response = await request(app).get('/ready?token=private').expect(500);
  const completed = entries.find(entry => entry.type === 'request.completed')!;
  const error = entries.find(entry => entry.type === 'request.error')!;
  assert.equal(completed.requestId, response.headers['x-request-id']);
  assert.equal(error.requestId, completed.requestId);
  assert.equal(error.error, failure);
  assert.equal(completed.status, 500);
  assert.equal(completed.route, '/ready');
  assert.equal(completed.level, 'error');
  assert.ok(completed.durationMs >= 0);
  await request(app).get('/private-path?token=secret').expect(404);
  assert.equal(entries.findLast(entry => entry.type === 'request.completed')!.route, 'unmatched');
  assert.ok(!JSON.stringify(entries).includes('private'));
});
