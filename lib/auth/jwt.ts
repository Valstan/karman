import { SignJWT, jwtVerify } from 'jose';

/**
 * Подпись/проверка сессионного JWT (HS256). Чистый jose — Edge-safe,
 * используется и в middleware, и в Node-роутах. Без БД и next/headers.
 */

export const SESSION_COOKIE = 'karman_session_v2';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 дней

const DEV_FALLBACK_SECRET = 'dev-insecure-secret-change-me';

let cachedKey: Uint8Array | null = null;

/**
 * Ленивый резолв ключа подписи. Проверка обязательного секрета отложена до
 * первого использования (а не на момент вычисления модуля): `next build`
 * импортирует роуты на этапе «Collecting page data» с NODE_ENV=production,
 * и top-level throw ломал бы сборку прод-артефакта без рантайм-секрета.
 * Fail-fast в production сохраняется — первый же запрос к защищённому
 * маршруту упадёт, если SESSION_SECRET не задан (см. также instrumentation.ts,
 * который валидирует секрет на старте сервера). См. план, раздел «Безопасность».
 */
function getSecretKey(): Uint8Array {
  if (cachedKey) {
    return cachedKey;
  }
  const secret = process.env.SESSION_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set in production');
  }
  cachedKey = new TextEncoder().encode(secret || DEV_FALLBACK_SECRET);
  return cachedKey;
}

/** mfa — сессия прошла второй фактор (TOTP/recovery); гейт раздела /secrets. */
export async function signSession(uid: number, mfa = false): Promise<string> {
  return new SignJWT({ uid, mfa })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecretKey());
}

export type SessionPayload = { uid: number; mfa: boolean };

export async function verifySessionPayload(
  token: string | undefined | null,
): Promise<SessionPayload | null> {
  if (!token) {
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (typeof payload.uid !== 'number') return null;
    return { uid: payload.uid, mfa: payload.mfa === true };
  } catch {
    return null;
  }
}

export async function verifySession(token: string | undefined | null): Promise<number | null> {
  return (await verifySessionPayload(token))?.uid ?? null;
}

// --- Промежуточный токен второго шага входа (пароль принят, ждём TOTP-код) ---

export const TOTP_PENDING_COOKIE = 'karman_totp_pending';
export const TOTP_PENDING_TTL_SECONDS = 5 * 60;

export async function signTotpPending(uid: number): Promise<string> {
  return new SignJWT({ uid, stage: 'totp' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${TOTP_PENDING_TTL_SECONDS}s`)
    .sign(getSecretKey());
}

export async function verifyTotpPending(token: string | undefined | null): Promise<number | null> {
  if (!token) {
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    return payload.stage === 'totp' && typeof payload.uid === 'number' ? payload.uid : null;
  } catch {
    return null;
  }
}
