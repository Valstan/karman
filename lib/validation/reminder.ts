import { z } from 'zod';
import { optionalDateString } from './common';

/**
 * Валидация напоминаний. `at` — московский момент 'YYYY-MM-DDTHH:MM' (datetime-local):
 * для разового — когда сработает; для повтора — якорь серии (дата старта + время).
 */

const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Укажите дату и время');

const localTime = z.string().regex(/^\d{2}:\d{2}$/, 'Время в формате ЧЧ:ММ');

export const reminderCreateSchema = z.object({
  title: z.string().trim().min(1, 'Введите заголовок').max(200),
  body: z.string().trim().max(2000).optional().default(''),
  at: localDateTime,
  priority: z.enum(['normal', 'high']).default('normal'),
  silent: z.coerce.boolean().optional().default(false),
  // Расписание:
  repeat: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']).default('none'),
  interval: z.coerce.number().int().min(1).max(366).default(1),
  weekdays: z.array(z.coerce.number().int().min(0).max(6)).optional().default([]),
  monthday: z.coerce.number().int().min(1).max(31).optional(),
  endType: z.enum(['never', 'afterN', 'until']).default('never'),
  endN: z.coerce.number().int().min(1).max(1000).optional(),
  // .optional(): форма опускает ключ при endType≠'until'. Zod v4 не считает
  // union-с-undefined опциональным ключом (в отличие от v3) → без этого
  // отсутствующий endUntil даёт "expected nonoptional".
  endUntil: optionalDateString.optional(),
  // Доставка (тихие часы / рабочие дни) — применяются движком к повторам:
  businessDaysOnly: z.coerce.boolean().optional().default(false),
  quietEnabled: z.coerce.boolean().optional().default(false),
  quietFrom: localTime.optional(),
  quietTo: localTime.optional(),
  quietDefer: localTime.optional(),
});

export const reminderUpdateSchema = reminderCreateSchema.extend({
  id: z.coerce.number().int().positive(),
});

export type ReminderCreateInput = z.infer<typeof reminderCreateSchema>;
export type ReminderUpdateInput = z.infer<typeof reminderUpdateSchema>;
