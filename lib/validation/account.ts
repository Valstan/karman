import { z } from 'zod';

/**
 * Валидация мультиаккаунта (задача владельца 2026-11-03): аккаунты внешних
 * сервисов, которыми владелец переключается, пока программирует.
 *
 * Пароль — обязательный при создании (он копируется в сервис, куда владелец
 * входит). Токены за активацию — необязательные: владелец вносит их, если
 * знает расход; без них статистика по проектам считает только активации.
 */

export const accountCreateSchema = z.object({
  title: z.string().trim().max(200, 'Слишком длинное название').optional().default(''),
  email: z
    .string()
    .trim()
    .min(3, 'Укажите почту')
    .max(320, 'Слишком длинная почта')
    .email('Почта выглядит неверно'),
  password: z.string().min(1, 'Укажите пароль').max(200, 'Слишком длинный пароль'),
});

export const accountUpdateSchema = z.object({
  id: z.coerce.number().int().positive(),
  title: z.string().trim().max(200, 'Слишком длинное название').optional(),
  email: z
    .string()
    .trim()
    .min(3, 'Укажите почту')
    .max(320, 'Слишком длинная почта')
    .email('Почта выглядит неверно')
    .optional(),
  password: z.string().min(1, 'Укажите пароль').max(200, 'Слишком длинный пароль').optional(),
  /**
   * Проект аккаунта: можно переключить на другой или снять (null).
   * undefined — «не меняю» (правка названия не должна затирать проект).
   */
  projectId: z.coerce.number().int().positive().nullable().optional(),
});

/** Активация аккаунта: копирование почты или пароля гасит его до завтра. */
export const accountActivateSchema = z.object({
  id: z.coerce.number().int().positive(),
  /** Проект, на который уходят токены этого аккаунта (может быть не указан). */
  projectId: z.coerce.number().int().positive().nullable().optional(),
  /** Токены за эту активацию; undefined — «не меняю». */
  tokens: z.coerce.number().int().min(0, 'Токены не могут быть отрицательными').max(100_000_000).optional(),
});

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1, 'Укажите название проекта').max(200, 'Слишком длинное название'),
});

export type AccountCreateInput = z.infer<typeof accountCreateSchema>;
export type AccountUpdateInput = z.infer<typeof accountUpdateSchema>;
export type AccountActivateInput = z.infer<typeof accountActivateSchema>;
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
