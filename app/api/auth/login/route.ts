import { NextResponse } from 'next/server';
import { or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { authUser } from '@/lib/db/schema';
import { verifyDjangoPassword } from '@/lib/auth/password';
import { setSessionCookie, setTotpPendingCookie, currentSessionEpoch } from '@/lib/auth/session';
import { loginGuardKey, loginAllowed, registerFailure, registerSuccess } from '@/lib/auth/login-guard';
import { totpEnabled, logAuthAudit } from '@/lib/services/twofactor';
import { touchLastLogin } from '@/lib/services/users';
import { clientIp } from '@/lib/api/client-ip';
import { loginSchema } from '@/lib/validation/auth';

// pbkdf2 (Django-хеши) требуют Node runtime.
export const runtime = 'nodejs';

/**
 * Тело входа — логин и пароль, то есть десятки байт. Лимит нужен не «на всякий случай»:
 * `client_max_body_size` в nginx стоит 100M, а `req.json()` читает поток ЦЕЛИКОМ до любой
 * проверки, поэтому анонимный запрос на 100 МБ читался в память процесса (аудит #057,
 * D1). 8 КБ — с запасом над формой.
 */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * Отсекаем не-JSON тело. HTML-форма умеет отправить `text/plain`/`multipart`, а
 * `Request.json()` разбирает такой body как JSON — то есть чужая страница могла
 * подсадить жертве сессию злоумышленника (login CSRF, аудит #057 R5). `fetch` без CORS
 * с `application/json` не пройдёт, а CORS-заголовков приложение не выдаёт.
 */
function isJsonRequest(req: Request): boolean {
  const contentType = req.headers.get('content-type') ?? '';
  return contentType.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

export async function POST(req: Request) {
  if (!isJsonRequest(req)) {
    return NextResponse.json({ message: 'Некорректный запрос' }, { status: 415 });
  }

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ message: 'Слишком большой запрос' }, { status: 413 });
  }

  const json = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ message: 'Введите логин и пароль' }, { status: 400 });
  }

  const { username, password } = parsed.data;
  const ip = clientIp(req);
  const guardKey = loginGuardKey(username, ip);
  const accountKey = username.trim().toLowerCase();

  if (!loginAllowed(guardKey, accountKey)) {
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
    const locked = registerFailure(guardKey, accountKey);
    await logAuthAudit(user?.id ?? null, username, locked ? 'login_lockout_set' : 'login_fail', ip);
    return NextResponse.json({ message: 'Неверный логин или пароль' }, { status: 401 });
  }

  registerSuccess(guardKey, accountKey);

  // Второй фактор включён → полной сессии ещё нет: короткий pending-cookie,
  // клиент показывает шаг TOTP-кода (POST /api/auth/totp).
  if (await totpEnabled(user.id)) {
    await setTotpPendingCookie(user.id);
    await logAuthAudit(user.id, username, 'login_password_ok', ip);
    return NextResponse.json({ totpRequired: true });
  }

  // Поколение обязательно: без него чеканется токен поколения 0, то есть тот самый,
  // который нельзя отозвать до первого инкремента счётчика (аудит #057 R2).
  const epoch = await currentSessionEpoch(user.id);
  if (epoch === null) {
    return NextResponse.json({ message: 'Неверный логин или пароль' }, { status: 401 });
  }
  await setSessionCookie(user.id, false, epoch);
  await touchLastLogin(user.id);
  await logAuthAudit(user.id, username, 'login_ok', ip);
  return NextResponse.json({
    user: { id: user.id, username: user.username, isSuperuser: user.isSuperuser },
  });
}
