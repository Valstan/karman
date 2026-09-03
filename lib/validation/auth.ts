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

/**
 * Приглашение: владелец заводит аккаунт родственнику. Логин ограничен теми же
 * символами, что и раньше принимала автогенерация из ЕСА (`A-Za-z0-9._-`) —
 * кириллический логин пришлось бы диктовать по буквам и раскладке, а он ещё и
 * участвует в сравнении `lower(username)`, где регистронезависимость для
 * кириллицы зависит от локали БД.
 *
 * Почта не обязательна, но если задана — по ней сработает привязка личности ЕСА
 * (`lib/services/oidc-login.ts`, исход `linked_by_email`), и человек сможет
 * входить кнопкой «Войти через ЕСА» вместо выданного пароля.
 */
export const accountCreateSchema = z.object({
  username: z
    .string()
    .trim()
    .min(2, 'Логин — минимум 2 символа')
    .max(150, 'Логин длиннее 150 символов')
    .regex(/^[A-Za-z0-9._-]+$/, 'Логин: латиница, цифры, точка, дефис, подчёркивание'),
  // Не union с z.literal(''): союз отдаёт наружу invalid_union вместо внятного
  // текста, а первое сообщение issues[0] — это ровно то, что увидит владелец
  // в тосте. `.default('')` здесь обязателен и по G70: в Zod v4 отсутствующий
  // ключ не становится опциональным сам.
  email: z
    .string()
    .trim()
    .max(254, 'Почта длиннее 254 символов')
    .refine((v) => v === '' || z.email().safeParse(v).success, 'Некорректная почта')
    .default(''),
  firstName: z.string().trim().max(150).default(''),
  lastName: z.string().trim().max(150).default(''),
});

/** Включение/отключение аккаунта владельцем. */
export const accountStateSchema = z.object({
  userId: z.coerce.number().int().positive(),
  isActive: z.boolean(),
});
