import { z } from 'zod';

/** Имя круга: короткое, но обязательное — безымянный круг не отличить от другого. */
export const circleNameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Название круга — минимум 2 символа')
    .max(100, 'Название длиннее 100 символов'),
});

export const circleRenameSchema = circleNameSchema.extend({
  circleId: z.coerce.number().int().positive(),
});

/**
 * Приглашение по ТОЧНОМУ логину. Список пользователей владельцу круга не
 * показывается (он положен только суперпользователю), поэтому логин вводится
 * руками — и требования к нему те же, что при заведении аккаунта.
 */
export const circleInviteSchema = z.object({
  circleId: z.coerce.number().int().positive(),
  username: z.string().trim().min(2, 'Введите логин').max(150),
});

export const circleRespondSchema = z.object({
  circleId: z.coerce.number().int().positive(),
  accept: z.boolean(),
});

export const circleMemberSchema = z.object({
  circleId: z.coerce.number().int().positive(),
  userId: z.coerce.number().int().positive(),
});

export const circleIdSchema = z.object({
  circleId: z.coerce.number().int().positive(),
});
