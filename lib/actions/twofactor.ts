'use server';

import { totpCodeSchema } from '@/lib/validation/auth';
import {
  startTotpEnrollment,
  confirmTotpEnrollment,
  disableTotp,
  logAuthAudit,
  bumpSessionEpoch,
  type TotpEnrollment,
} from '@/lib/services/twofactor';
import { rotateSessionCookie } from '@/lib/auth/session';
import { requireAccountSecurity } from '@/lib/auth/step-up';
import { revalidateAll, type ActionResult } from './_internal';

/**
 * Управление 2FA — операции, меняющие безопасность учётки, поэтому гейт здесь не «вошёл»,
 * а `requireAccountSecurity` (аудит #057 R4).
 *
 * Что это закрывает: сессия учётки БЕЗ включённой 2FA позволяла подвесить свой TOTP —
 * сервис отдаёт секрет и десять recovery-кодов открытым текстом, 2FA включается, а владельца
 * вышибает из `/secrets` (его сессии `mfa:false`, а гейт требует `mfa` при включённом 2FA),
 * и восстановления в приложении нет: `auth_totp` удаляется только self-service с кодом
 * владельца. При включённой 2FA путь закрыт и раньше (`startTotpEnrollment` возвращает null),
 * поэтому правка бьёт именно по учёткам без 2FA.
 *
 * Второй фактор здесь НЕ переспрашивается — сверяется claim `mfa` в уже выданной сессии:
 * требовать код в момент включения нельзя, иначе включить 2FA получится только у того, у кого
 * она уже включена.
 *
 * Плюс `bumpSessionEpoch` в обоих исходах: включение 2FA убивает сессии без второго фактора
 * (они больше не проходят гейт `/secrets`), выключение возвращает кейчу — и старая сессия, с
 * которой 2FA только что отключили, не должна мгновенно получить доступ к vault.
 */
export async function startTotpEnrollmentAction(): Promise<ActionResult<TotpEnrollment>> {
  const guard = await requireAccountSecurity();
  if (guard.user === null) return { ok: false, error: guard.error };
  const user = guard.user;
  try {
    const enrollment = await startTotpEnrollment(user.id, user.username);
    if (!enrollment) return { ok: false, error: '2FA уже включена' };
    return { ok: true, data: enrollment };
  } catch {
    return { ok: false, error: 'Сервис секретов недоступен (мастер-ключ?)' };
  }
}

/** Подтверждает 2FA первым кодом; возвращает recovery-коды ОДИН раз. */
export async function confirmTotpEnrollmentAction(
  values: unknown,
): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  const guard = await requireAccountSecurity();
  if (guard.user === null) return { ok: false, error: guard.error };
  const user = guard.user;
  const parsed = totpCodeSchema.safeParse(values);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Введите код' };
  const result = await confirmTotpEnrollment(user.id, parsed.data.code);
  if (!result) return { ok: false, error: 'Неверный код — проверьте приложение и попробуйте ещё раз' };
  await logAuthAudit(user.id, user.username, 'totp_enrolled', null);
  await bumpSessionEpoch(user.id);
  await rotateSessionCookie(user.id);
  revalidateAll();
  return { ok: true, data: result };
}

/** Отключает 2FA (нужен действующий TOTP-код). */
export async function disableTotpAction(values: unknown): Promise<ActionResult> {
  const guard = await requireAccountSecurity();
  if (guard.user === null) return { ok: false, error: guard.error };
  const user = guard.user;
  const parsed = totpCodeSchema.safeParse(values);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Введите код' };
  const ok = await disableTotp(user.id, parsed.data.code);
  if (!ok) return { ok: false, error: 'Неверный код' };
  await logAuthAudit(user.id, user.username, 'totp_disabled', null);
  await bumpSessionEpoch(user.id);
  await rotateSessionCookie(user.id);
  revalidateAll();
  return { ok: true };
}