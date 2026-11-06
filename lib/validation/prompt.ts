import { z } from 'zod';
import { MAX_PROMPT_LENGTH, MAX_PROMPT_TITLE_LENGTH } from '@/lib/prompts/normalize';

/**
 * Валидация промтов (заказ владельца 2026-11-06).
 *
 * Ограничения здесь — не прихоть валидатора, а границы колонок в миграции
 * 0025 и потолок, за которым «промт» превращается в документ.
 */

/** Управляющие символы в имени проекта делают раздел нечитаемым. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Имя проекта-раздела: без управляющих символов, до 64 символов. */
const projectName = z
  .string()
  .trim()
  .min(1, 'Укажите проект — без раздела промт некуда положить')
  .max(64, 'Название проекта длиннее 64 символов')
  .refine((value) => !CONTROL_CHARS.test(value), {
    message: 'Название проекта с управляющими символами',
  });

/** Тело промта: обязательное, с потолком длины. */
const promptBody = z
  .string()
  .min(1, 'Промт пуст')
  .max(MAX_PROMPT_LENGTH, `Промт длиннее ${MAX_PROMPT_LENGTH} символов`);

/** Заголовок необязателен: пустой — значит, возьмём первую строку промта. */
const promptTitle = z
  .string()
  .trim()
  .max(MAX_PROMPT_TITLE_LENGTH, `Заголовок длиннее ${MAX_PROMPT_TITLE_LENGTH} символов`)
  .optional()
  .default('');

export const promptCreateSchema = z.object({
  project: projectName,
  title: promptTitle,
  body: promptBody,
});

export const promptIdSchema = z.coerce.number().int().positive('Некорректный id промта');

/**
 * Очистка архива. `before` — необязательная дата 'YYYY-MM-DD': удалить всё
 * архивное старше этой даты. Без даты — очистить архив целиком.
 */
export const promptPurgeSchema = z.object({
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД')
    .optional(),
});

export type PromptCreateInput = z.infer<typeof promptCreateSchema>;
export type PromptPurgeInput = z.infer<typeof promptPurgeSchema>;
