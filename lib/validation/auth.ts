import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Введите логин'),
  password: z.string().min(1, 'Введите пароль'),
});

/** Второй шаг входа / подтверждение enrollment: TOTP-код или recovery-код. */
export const totpCodeSchema = z.object({
  code: z.string().trim().min(6, 'Введите код').max(20),
});
