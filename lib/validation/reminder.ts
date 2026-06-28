import { z } from 'zod';
import { optionalDateString, dateString } from './common';

/**
 * Валидация напоминаний. `at` — московский момент 'YYYY-MM-DDTHH:MM' (datetime-local):
 * для разового — когда сработает; для повтора — якорь серии (дата старта + время).
 * Для режима `repeat:'dates'` (произвольные даты) `at` не нужен — расписание задаётся
 * списком `dates` + единым временем `datesTime`.
 */

const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Укажите дату и время');

const localTime = z.string().regex(/^\d{2}:\d{2}$/, 'Время в формате ЧЧ:ММ');

// Общий набор полей; create/update различаются только наличием `id`. superRefine
// нельзя навесить до `.extend`, поэтому держим поля отдельно и собираем оба варианта.
const reminderFields = {
  title: z.string().trim().min(1, 'Введите заголовок').max(200),
  body: z.string().trim().max(2000).optional().default(''),
  // Опционально: для repeat:'dates' момент задаётся списком дат (см. superRefine).
  at: localDateTime.optional(),
  priority: z.enum(['normal', 'high']).default('normal'),
  silent: z.coerce.boolean().optional().default(false),
  // Расписание:
  repeat: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly', 'dates']).default('none'),
  interval: z.coerce.number().int().min(1).max(366).default(1),
  weekdays: z.array(z.coerce.number().int().min(0).max(6)).optional().default([]),
  monthday: z.coerce.number().int().min(1).max(31).optional(),
  // Произвольные даты (repeat:'dates'): набор дат + единое время для всех.
  dates: z.array(dateString).optional().default([]),
  datesTime: localTime.optional(),
  endType: z.enum(['never', 'afterN', 'until']).default('never'),
  endN: z.coerce.number().int().min(1).max(1000).optional(),
  // Форма опускает ключ при endType≠'until' — `optionalDateString` теперь сам
  // опускаемый (корневой фикс в common.ts под Zod v4), отдельный .optional() не нужен.
  endUntil: optionalDateString,
  // Доставка (тихие часы / рабочие дни) — применяются движком к повторам:
  businessDaysOnly: z.coerce.boolean().optional().default(false),
  quietEnabled: z.coerce.boolean().optional().default(false),
  quietFrom: localTime.optional(),
  quietTo: localTime.optional(),
  quietDefer: localTime.optional(),
} as const;

/** repeat:'dates' требует ≥1 даты; остальные режимы требуют `at`. */
function refineReminder(
  v: { repeat: string; at?: string; dates: string[] },
  ctx: z.RefinementCtx,
): void {
  if (v.repeat === 'dates') {
    if (v.dates.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['dates'], message: 'Добавьте хотя бы одну дату' });
    }
  } else if (!v.at) {
    ctx.addIssue({ code: 'custom', path: ['at'], message: 'Укажите дату и время' });
  }
}

export const reminderCreateSchema = z.object(reminderFields).superRefine(refineReminder);

export const reminderUpdateSchema = z
  .object({ ...reminderFields, id: z.coerce.number().int().positive() })
  .superRefine(refineReminder);

export type ReminderCreateInput = z.infer<typeof reminderCreateSchema>;
export type ReminderUpdateInput = z.infer<typeof reminderUpdateSchema>;
