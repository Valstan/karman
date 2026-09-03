'use server';

import {
  accountCreateSchema,
  accountStateSchema,
  passwordChangeSchema,
  passwordResetSchema,
} from '@/lib/validation/auth';
import {
  changeOwnPassword,
  createAccount,
  resetAccountPassword,
  setAccountActive,
} from '@/lib/services/users';
import { currentUserOrNull, revalidateAll, type ActionResult } from './_internal';

/**
 * Заводит аккаунт по приглашению владельца (superuser). Временный пароль
 * возвращается ОДИН раз — показать и продиктовать; повторно его не достать,
 * только сбросить.
 */
export async function createAccountAction(
  values: unknown,
): Promise<ActionResult<{ username: string; tempPassword: string }>> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = accountCreateSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  const result = await createAccount(user, parsed.data);
  if (!result.ok) return { ok: false, error: result.error };
  revalidateAll();
  return { ok: true, data: { username: result.username, tempPassword: result.tempPassword } };
}

/** Включает или отключает аккаунт (superuser). Себя отключить нельзя. */
export async function setAccountActiveAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = accountStateSchema.safeParse(values);
  if (!parsed.success) return { ok: false, error: 'Некорректный запрос' };
  const result = await setAccountActive(user, parsed.data.userId, parsed.data.isActive);
  if (!result.ok) return { ok: false, error: result.error };
  revalidateAll();
  return { ok: true };
}

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
