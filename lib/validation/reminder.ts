import { z } from 'zod';
import { optionalDateString } from './common';

/**
 * Валидация напоминаний. `at` — московский момент 'YYYY-MM-DDTHH:MM' (datetime-local):
 * для разового — когда сработает; для повтора — якорь серии (дата старта + время).
 */

const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Укажите дату и время');

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
  endUntil: optionalDateString,
});

export const reminderUpdateSchema = reminderCreateSchema.extend({
  id: z.coerce.number().int().positive(),
});

export type ReminderCreateInput = z.infer<typeof reminderCreateSchema>;
export type ReminderUpdateInput = z.infer<typeof reminderUpdateSchema>;
