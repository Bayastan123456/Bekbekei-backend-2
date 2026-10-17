import { z } from 'zod';
import { uuid } from '../core.js';
export const pickingActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('PICK') }),
  z.object({ action: z.literal('EXCLUDE') }),
  z.object({ action: z.literal('PROPOSE_REPLACEMENT'), productId: uuid }),
]);
export type PickingAction = z.infer<typeof pickingActionSchema>;
