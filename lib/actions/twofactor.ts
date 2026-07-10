'use server';

import { totpCodeSchema } from '@/lib/validation/auth';
import {
  startTotpEnrollment,
  confirmTotpEnrollment,
  disableTotp,
  logAuthAudit,
  type TotpEnrollment,
} from '@/lib/services/twofactor';
import { currentUserOrNull, revalidateAll, type ActionResult } from './_internal';

/** Начинает подключение 2FA: секрет + QR (не активен до подтверждения кодом). */
export async function startTotpEnrollmentAction(): Promise<ActionResult<TotpEnrollment>> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
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
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = totpCodeSchema.safeParse(values);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Введите код' };
  const result = await confirmTotpEnrollment(user.id, parsed.data.code);
  if (!result) return { ok: false, error: 'Неверный код — проверьте приложение и попробуйте ещё раз' };
  await logAuthAudit(user.id, user.username, 'totp_enrolled', null);
  revalidateAll();
  return { ok: true, data: result };
}

/** Отключает 2FA (нужен действующий TOTP-код). */
export async function disableTotpAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = totpCodeSchema.safeParse(values);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Введите код' };
  const ok = await disableTotp(user.id, parsed.data.code);
  if (!ok) return { ok: false, error: 'Неверный код' };
  await logAuthAudit(user.id, user.username, 'totp_disabled', null);
  revalidateAll();
  return { ok: true };
}
