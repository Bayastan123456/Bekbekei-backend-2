import { z } from 'zod';
import { money, uuid } from '../core.js';
export const checkoutSchema = z
  .object({
    addressId: uuid,
    paymentMethod: z.enum(['CASH', 'QR']),
    email: z.email().max(254).optional(),
    courierComment: z.string().max(1000).default(''),
    cashChangeFrom: money.optional(),
    promoCode: z.string().min(1).max(40).optional(),
    ageConfirmed: z.boolean().default(false),
  })
  .strict();
export type Checkout = z.infer<typeof checkoutSchema>;
export function idempotencyKey(raw: unknown) {
  return z
    .string()
    .min(8)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .parse(raw);
}
