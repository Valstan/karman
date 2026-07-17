'use server';

import { passwordChangeSchema, passwordResetSchema } from '@/lib/validation/auth';
import { changeOwnPassword, resetAccountPassword } from '@/lib/services/users';
import { currentUserOrNull, type ActionResult } from './_internal';

/** Сбрасывает пароль аккаунта на временный (superuser). Пароль возвращается ОДИН раз. */
export async function resetAccountPasswordAction(
  values: unknown,
): Promise<ActionResult<{ username: string; tempPassword: string }>> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = passwordResetSchema.safeParse(values);
  if (!parsed.success) return { ok: false, error: 'Некорректный запрос' };
  const result = await resetAccountPassword(user, parsed.data.userId);
  if (!result) return { ok: false, error: 'Нет прав или аккаунт не найден' };
  return { ok: true, data: result };
}

/** Меняет собственный пароль (нужен действующий текущий). */
export async function changeOwnPasswordAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = passwordChangeSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  const ok = await changeOwnPassword(user, parsed.data.currentPassword, parsed.data.nextPassword);
  if (!ok) return { ok: false, error: 'Текущий пароль неверен' };
  return { ok: true };
}
