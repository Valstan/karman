import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Введите логин'),
  password: z.string().min(1, 'Введите пароль'),
});

/** Второй шаг входа / подтверждение enrollment: TOTP-код или recovery-код. */
export const totpCodeSchema = z.object({
  code: z.string().trim().min(6, 'Введите код').max(20),
});

/** Смена собственного пароля (восстановление доступа). */
export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1, 'Введите текущий пароль'),
  nextPassword: z.string().min(8, 'Новый пароль — минимум 8 символов').max(128),
});

/** Сброс пароля аккаунта суперпользователем. */
export const passwordResetSchema = z.object({
  userId: z.coerce.number().int().positive(),
});
