import 'server-only';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession, verifySession } from './jwt';

/**
 * Cookie-хелперы сессии (через next/headers). Атрибуты cookie сохраняют
 * семантику старого karman_session: HttpOnly; SameSite=Lax; Path=/; Secure в проде.
 */

export async function setSessionCookie(uid: number): Promise<void> {
  const token = await signSession(uid);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export async function readSessionUid(): Promise<number | null> {
  const cookieStore = await cookies();
  return verifySession(cookieStore.get(SESSION_COOKIE)?.value);
}
