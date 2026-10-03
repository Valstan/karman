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
import { rotateSessionCookie } from '@/lib/auth/session';
import { requireAccountSecurity } from '@/lib/auth/step-up';
import { currentUserOrNull, revalidateAll, type ActionResult } from './_internal';

/**
 * Управление аккаунтами (восстановление доступа) — три операции меняют безопасность учётки,
 * и все три теперь за step-up (аудит #057 R3).
 *
 * `resetAccountPassword` был самым дорогим случаем: гейт только «суперпользователь», а ответ
 * возвращает временный пароль ОТКРЫТЫМ ТЕКСТОМ. Сессия суперпользователя — bearer, поэтому
 * украденная cookie (даже без `mfa`) давала захват любой учётки системы. Теперь операция
 * требует, чтобы вход уже прошёл со вторым фактором — ровно как привязка ЕСА.
 *
 * `changeOwnPassword` спрашивает текущий пароль сам (это и есть его step-up), поэтому
 * дополнительный гейт не нужен: второй пароль в форме уже доказательство владения.
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
  const guard = await requireAccountSecurity();
  if (guard.user === null) return { ok: false, error: guard.error };
  const parsed = accountStateSchema.safeParse(values);
  if (!parsed.success) return { ok: false, error: 'Некорректный запрос' };
  const result = await setAccountActive(guard.user, parsed.data.userId, parsed.data.isActive);
  if (!result.ok) return { ok: false, error: result.error };
  revalidateAll();
  return { ok: true };
}

/**
 * Сбрасывает пароль аккаунта на временный (superuser). Пароль возвращается ОДИН раз.
 *
 * После сброса растёт поколение сессии: все ранее выданные токены этой учётки мертвы, иначе
 * операция, которой владелец закрывает последствия кражи, сама бы их не закрыла. Текущий
 * браузер владельца перевыпускается — если он сбрасывает пароль СЕБЕ, разлогинивать его не
 * нужно; если другому человеку, перевыпуск не меняет ничего, потому что cookie у того своя.
 */
export async function resetAccountPasswordAction(
  values: unknown,
): Promise<ActionResult<{ username: string; tempPassword: string }>> {
  const guard = await requireAccountSecurity();
  if (guard.user === null) return { ok: false, error: guard.error };
  const parsed = passwordResetSchema.safeParse(values);
  if (!parsed.success) return { ok: false, error: 'Некорректный запрос' };
  const result = await resetAccountPassword(guard.user, parsed.data.userId);
  if (!result) return { ok: false, error: 'Нет прав или аккаунт не найден' };
  if (parsed.data.userId === guard.user.id) await rotateSessionCookie(guard.user.id);
  return { ok: true, data: result };
}

/**
 * Меняет собственный пароль (нужен действующий текущий).
 *
 * Растёт поколение сессии, и cookie перевыпускается: иначе смена пароля убила бы и текущий
 * браузер (он легитимный), а старые токены на других устройствах продолжали бы работать ещё
 * 14 дней — то есть операция была бы косметической.
 */
export async function changeOwnPasswordAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = passwordChangeSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  const ok = await changeOwnPassword(user, parsed.data.currentPassword, parsed.data.nextPassword);
  if (!ok) return { ok: false, error: 'Текущий пароль неверен' };
  await rotateSessionCookie(user.id);
  return { ok: true };
}