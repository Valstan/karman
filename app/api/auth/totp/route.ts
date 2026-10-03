import { NextResponse } from 'next/server';
import {
  setSessionCookie,
  readTotpPendingUid,
  clearTotpPendingCookie,
} from '@/lib/auth/session';
import { loginGuardKey, loginAllowed, registerFailure, registerSuccess } from '@/lib/auth/login-guard';
import { verifySecondFactor, logAuthAudit } from '@/lib/services/twofactor';
import { clientIp } from '@/lib/api/client-ip';
import { totpCodeSchema } from '@/lib/validation/auth';

// Расшифровка секрета TOTP (node:crypto) требует Node runtime.
export const runtime = 'nodejs';

/**
 * Второй шаг входа: pending-cookie (пароль принят) + TOTP/recovery-код →
 * полная сессия с mfa:true. Перебор кода душится тем же login-guard.
 */
export async function POST(req: Request) {
  const uid = await readTotpPendingUid();
  if (uid === null) {
    return NextResponse.json(
      { message: 'Сессия входа истекла — войдите заново' },
      { status: 401 },
    );
  }

  const json = await req.json().catch(() => null);
  const parsed = totpCodeSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ message: 'Введите код' }, { status: 400 });
  }

  const ip = clientIp(req);
  // Второй фактор ограничен по ТОМУ ЖЕ логину: 6 цифр перебираются за минуты, а ключ
  // с адресом обходился ротацией заголовка (аудит #057, R1).
  const accountKey = `totp:${uid}`;
  const guardKey = loginGuardKey(accountKey, ip);
  if (!loginAllowed(guardKey, accountKey)) {
    await logAuthAudit(uid, null, 'totp_locked', ip);
    return NextResponse.json(
      { message: 'Слишком много неудачных попыток. Попробуйте через 15 минут.' },
      { status: 429 },
    );
  }

  const result = await verifySecondFactor(uid, parsed.data.code);
  if (!result.ok) {
    registerFailure(guardKey, accountKey);
    await logAuthAudit(uid, null, 'totp_fail', ip);
    return NextResponse.json({ message: 'Неверный код' }, { status: 401 });
  }

  registerSuccess(guardKey, accountKey);
  await clearTotpPendingCookie();
  await setSessionCookie(uid, true);
  await logAuthAudit(uid, null, result.usedRecovery ? 'login_ok_recovery' : 'login_ok_totp', ip);
  return NextResponse.json({ ok: true });
}
