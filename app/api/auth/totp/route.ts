import { NextResponse } from 'next/server';
import {
  setSessionCookie,
  readTotpPendingUid,
  clearTotpPendingCookie,
} from '@/lib/auth/session';
import { loginGuardKey, loginAllowed, registerFailure, registerSuccess } from '@/lib/auth/login-guard';
import { verifySecondFactor, logAuthAudit } from '@/lib/services/twofactor';
import { totpCodeSchema } from '@/lib/validation/auth';

// Расшифровка секрета TOTP (node:crypto) требует Node runtime.
export const runtime = 'nodejs';

function clientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() ?? null;
  return req.headers.get('x-real-ip');
}

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
  const guardKey = loginGuardKey(`totp:${uid}`, ip);
  if (!loginAllowed(guardKey)) {
    await logAuthAudit(uid, null, 'totp_locked', ip);
    return NextResponse.json(
      { message: 'Слишком много неудачных попыток. Попробуйте через 15 минут.' },
      { status: 429 },
    );
  }

  const result = await verifySecondFactor(uid, parsed.data.code);
  if (!result.ok) {
    registerFailure(guardKey);
    await logAuthAudit(uid, null, 'totp_fail', ip);
    return NextResponse.json({ message: 'Неверный код' }, { status: 401 });
  }

  registerSuccess(guardKey);
  await clearTotpPendingCookie();
  await setSessionCookie(uid, true);
  await logAuthAudit(uid, null, result.usedRecovery ? 'login_ok_recovery' : 'login_ok_totp', ip);
  return NextResponse.json({ ok: true });
}
