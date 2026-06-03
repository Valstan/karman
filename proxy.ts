import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from '@/lib/auth/jwt';

/**
 * Дешёвый Edge-гард (Next 16 «proxy», ранее middleware): проверяет JWT из cookie
 * без БД и перенаправляет. Авторитетная проверка (включая is_active) — в
 * app/(app)/layout.tsx.
 */
export async function proxy(req: NextRequest) {
  const uid = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  const isLogin = req.nextUrl.pathname === '/login';

  if (!uid && !isLogin) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }

  if (uid && isLogin) {
    const url = req.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Пропускаем api-роуты, статику Next и файлы с расширением.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
