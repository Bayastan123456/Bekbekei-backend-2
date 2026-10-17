import { z } from 'zod';
import { money, uuid } from '../core.js';
export const localized = z
  .object({ ru: z.string().min(1).max(5000), ky: z.string().max(5000).optional(), en: z.string().max(5000).optional() })
  .strict();
export const optionalLocalized = z
  .object({
    ru: z.string().max(5000).optional(),
    ky: z.string().max(5000).optional(),
    en: z.string().max(5000).optional(),
  })
  .strict();
export const imageUrl = z
  .url()
  .refine(v => v.startsWith('https://'), 'Изображение должно иметь HTTPS URL')
  .nullable()
  .optional();
export const productSchema = z
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
export const storeSchema = z
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
