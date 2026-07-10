import { NextResponse } from 'next/server';
import { or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { authUser } from '@/lib/db/schema';
import { verifyDjangoPassword } from '@/lib/auth/password';
import { setSessionCookie, setTotpPendingCookie } from '@/lib/auth/session';
import { loginGuardKey, loginAllowed, registerFailure, registerSuccess } from '@/lib/auth/login-guard';
import { totpEnabled, logAuthAudit } from '@/lib/services/twofactor';
import { loginSchema } from '@/lib/validation/auth';

// pbkdf2 (Django-хеши) требует Node runtime.
export const runtime = 'nodejs';

function clientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() ?? null;
  return req.headers.get('x-real-ip');
}

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ message: 'Введите логин и пароль' }, { status: 400 });
  }

  const { username, password } = parsed.data;
  const ip = clientIp(req);
  const guardKey = loginGuardKey(username, ip);

  if (!loginAllowed(guardKey)) {
    await logAuthAudit(null, username, 'login_locked', ip);
    return NextResponse.json(
      { message: 'Слишком много неудачных попыток. Попробуйте через 15 минут.' },
      { status: 429 },
    );
  }

  const rows = await db
    .select()
    .from(authUser)
    .where(
      or(
        sql`lower(${authUser.username}) = lower(${username})`,
        sql`lower(${authUser.email}) = lower(${username})`,
      ),
    )
    .orderBy(authUser.id)
    .limit(1);

  const user = rows[0];
  if (!user || !user.isActive || !verifyDjangoPassword(password, user.password)) {
    const locked = registerFailure(guardKey);
    await logAuthAudit(user?.id ?? null, username, locked ? 'login_lockout_set' : 'login_fail', ip);
    return NextResponse.json({ message: 'Неверный логин или пароль' }, { status: 401 });
  }

  registerSuccess(guardKey);

  // Второй фактор включён → полной сессии ещё нет: короткий pending-cookie,
  // клиент показывает шаг TOTP-кода (POST /api/auth/totp).
  if (await totpEnabled(user.id)) {
    await setTotpPendingCookie(user.id);
    await logAuthAudit(user.id, username, 'login_password_ok', ip);
    return NextResponse.json({ totpRequired: true });
  }

  await setSessionCookie(user.id);
  await logAuthAudit(user.id, username, 'login_ok', ip);
  return NextResponse.json({
    user: { id: user.id, username: user.username, isSuperuser: user.isSuperuser },
  });
}
