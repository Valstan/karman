import { z } from 'zod';

/**
 * Адрес сайта: только http/https (аудит #057, I2).
 *
 * Поле попадает в `href` в общем справочнике, то есть значение, записанное любым
 * вошедшим, показывается владельцу. `javascript:`/`data:` React сам срезает при записи в
 * DOM (находка была опровергнута именно этим), но полагаться на `sanitizeURL` — значит
 * держать безопасность на версии библиотеки; allowlist протокола стоит копей и делает
 * класс невозможным в принципе, а не только в текущей сборке.
 */
const httpUrl = z
  .string()
  .trim()
  .max(200)
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Адрес должен начинаться с http:// или https://')
  .optional()
  .nullable();

export const bankCreateSchema = z.object({
  name: z.string().trim().min(1, 'Введите название').max(200),
  address: z.string().trim().max(2000).optional().nullable(),
  phone: z.string().trim().max(20).optional().nullable(),
  email: z.string().trim().max(254).optional().nullable(),
  website: httpUrl,
});

export const bankUpdateSchema = bankCreateSchema.partial().extend({
  id: z.coerce.number().int().positive(),
});

export type BankCreateInput = z.infer<typeof bankCreateSchema>;
export type BankUpdateInput = z.infer<typeof bankUpdateSchema>;
