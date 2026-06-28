import { z } from 'zod';

/** Валидация менеджера секретов. */

export const secretProjectCreateSchema = z.object({
  name: z.string().trim().min(1, 'Введите название').max(200),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$|^[a-z0-9]$/, 'Слаг: латиница в нижнем регистре, цифры, дефис'),
});

export const secretProjectUpdateSchema = secretProjectCreateSchema.extend({
  id: z.coerce.number().int().positive(),
});

export const secretItemUpsertSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  // Имя ключа в стиле env-переменной.
  key: z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Ключ: буквы/цифры/_, начинается с буквы или _')
    .max(200),
  value: z.string().min(1, 'Пустое значение').max(65536, 'Слишком большое значение (макс 64 КБ)'),
});

export const secretTokenCreateSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  name: z.string().trim().min(1, 'Введите название токена').max(200),
});

export type SecretProjectCreateInput = z.infer<typeof secretProjectCreateSchema>;
export type SecretProjectUpdateInput = z.infer<typeof secretProjectUpdateSchema>;
export type SecretItemUpsertInput = z.infer<typeof secretItemUpsertSchema>;
export type SecretTokenCreateInput = z.infer<typeof secretTokenCreateSchema>;
