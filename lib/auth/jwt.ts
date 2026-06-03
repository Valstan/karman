import { SignJWT, jwtVerify } from 'jose';

/**
 * Подпись/проверка сессионного JWT (HS256). Чистый jose — Edge-safe,
 * используется и в middleware, и в Node-роутах. Без БД и next/headers.
 */

export const SESSION_COOKIE = 'karman_session_v2';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 дней

const SECRET = process.env.SESSION_SECRET;
// Fail-fast: в production секрет обязателен (см. план, раздел «Безопасность»).
if (!SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('SESSION_SECRET must be set in production');
}
const secretKey = new TextEncoder().encode(SECRET || 'dev-insecure-secret-change-me');

export async function signSession(uid: number): Promise<string> {
  return new SignJWT({ uid })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey);
}

export async function verifySession(token: string | undefined | null): Promise<number | null> {
  if (!token) {
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, secretKey);
    return typeof payload.uid === 'number' ? payload.uid : null;
  } catch {
    return null;
  }
}
