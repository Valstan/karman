import { z } from 'zod';

/**
 * Валидация freeform-напоминаний (P1). Расписание v1 — разовое: момент `at`
 * в московском wall-clock 'YYYY-MM-DDTHH:MM' (datetime-local из формы). Повторы и
 * привязка к событиям — P3/P4.
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
});

export const reminderUpdateSchema = reminderCreateSchema.partial().extend({
  id: z.coerce.number().int().positive(),
});

export type ReminderCreateInput = z.infer<typeof reminderCreateSchema>;
export type ReminderUpdateInput = z.infer<typeof reminderUpdateSchema>;
