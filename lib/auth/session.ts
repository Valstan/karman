import 'server-only';
import { cookies } from 'next/headers';
import {
  OIDC_STATE_COOKIE,
  OIDC_STATE_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  TOTP_PENDING_COOKIE,
  TOTP_PENDING_TTL_SECONDS,
  signOidcState,
  signSession,
  signTotpPending,
  verifyOidcState,
  verifySession,
  verifySessionPayload,
  verifyTotpPending,
  type OidcStatePayload,
  type SessionPayload,
} from './jwt';

/**
 * Cookie-хелперы сессии (через next/headers). Атрибуты cookie сохраняют
 * семантику старого karman_session: HttpOnly; SameSite=Lax; Path=/; Secure в проде.
 */

const COOKIE_ATTRS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: process.env.NODE_ENV === 'production',
} as const;

export async function setSessionCookie(uid: number, mfa = false): Promise<void> {
  const token = await signSession(uid, mfa);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, { ...COOKIE_ATTRS, maxAge: SESSION_TTL_SECONDS });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export async function readSessionUid(): Promise<number | null> {
  const cookieStore = await cookies();
  return verifySession(cookieStore.get(SESSION_COOKIE)?.value);
}

/** Полный payload сессии (uid + mfa) — для гейта /secrets. */
export async function readSessionPayload(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  return verifySessionPayload(cookieStore.get(SESSION_COOKIE)?.value);
}

// --- Второй шаг входа (пароль принят, ждём TOTP-код) --------------------------

export async function setTotpPendingCookie(uid: number): Promise<void> {
  const token = await signTotpPending(uid);
  const cookieStore = await cookies();
  cookieStore.set(TOTP_PENDING_COOKIE, token, {
    ...COOKIE_ATTRS,
    maxAge: TOTP_PENDING_TTL_SECONDS,
  });
}

export async function readTotpPendingUid(): Promise<number | null> {
  const cookieStore = await cookies();
  return verifyTotpPending(cookieStore.get(TOTP_PENDING_COOKIE)?.value);
}

export async function clearTotpPendingCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(TOTP_PENDING_COOKIE);
}

// --- Состояние браузерного редиректа ЕСА --------------------------------------

export async function setOidcStateCookie(payload: OidcStatePayload): Promise<void> {
  const token = await signOidcState(payload);
  const cookieStore = await cookies();
  cookieStore.set(OIDC_STATE_COOKIE, token, { ...COOKIE_ATTRS, maxAge: OIDC_STATE_TTL_SECONDS });
}

export async function readOidcState(): Promise<OidcStatePayload | null> {
  const cookieStore = await cookies();
  return verifyOidcState(cookieStore.get(OIDC_STATE_COOKIE)?.value);
}

export async function clearOidcStateCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(OIDC_STATE_COOKIE);
}
