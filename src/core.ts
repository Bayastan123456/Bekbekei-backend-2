import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { SQL } from './db.js';
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function assert(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new AppError(status, code, message);
}
export const phone = z.string().regex(/^\+996\d{9}$/, 'Формат телефона: +996XXXXXXXXX');
export const uuid = z.string().uuid();
export const language = z.enum(['ru', 'ky', 'en']);
export const money = z.number().int().min(0).max(100_000_000);
export const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export const otpHash = (secret: string, phone: string, code: string) =>
  createHmac('sha256', secret).update(`${phone}:${code}`).digest('hex');
export const token = () => randomBytes(32).toString('hex');
export function equal(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function passwordValid(password: string, hash: string) {
  const [salt, expected] = hash.split(':');
  return !!salt && !!expected && equal(scryptSync(password, salt, 64).toString('hex'), expected);
}
export function page(query: Record<string, unknown>) {
  const schema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  });
  return schema.parse(query);
}
export async function event(
  tx: SQL,
  type: string,
  payload: unknown,
  userId: string | null = null,
  storeId: string | null = null,
  role: string | null = null,
) {
  await tx.query('INSERT INTO events(type,payload,user_id,store_id,role) VALUES($1,$2,$3,$4,$5)', [
    type,
    JSON.stringify(payload),
    userId,
    storeId,
    role,
  ]);
}
export interface Config {
  env: string;
  otpSecret: string;
  webhookSecret: string;
  smsProvider: 'log';
  paymentProvider: 'mock' | 'disabled';
  corsOrigins: string[];
  logger: (data: Record<string, unknown>) => void;
}
export function config(): Config {
  const env = process.env.NODE_ENV ?? 'development';
  const otpSecret = process.env.OTP_SECRET ?? '';
  const webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET ?? '';
  assert(
    otpSecret.length >= 32 && !otpSecret.startsWith('replace-'),
    500,
    'CONFIG',
    'Задайте случайный OTP_SECRET длиной от 32 символов',
  );
  assert(
    webhookSecret.length >= 32 && !webhookSecret.startsWith('replace-'),
    500,
    'CONFIG',
    'Задайте случайный PAYMENT_WEBHOOK_SECRET длиной от 32 символов',
  );
  assert((process.env.SMS_PROVIDER ?? 'log') === 'log', 500, 'CONFIG', 'Пока реализован только SMS_PROVIDER=log');
  const paymentProvider = z.enum(['mock', 'disabled']).parse(process.env.PAYMENT_PROVIDER ?? 'mock');
  assert(
    env !== 'production',
    500,
    'PRODUCTION_ADAPTER_REQUIRED',
    'SMS в логах и тестовые адаптеры запрещены в production. Подключите реальные SMS и платежи перед запуском',
  );
  return {
    env,
    otpSecret,
    webhookSecret,
    smsProvider: 'log',
    paymentProvider,
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(','),
    logger: data => console.log(JSON.stringify(data)),
  };
}
