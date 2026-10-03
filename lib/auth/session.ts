import 'server-only';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { authUser } from '@/lib/db/schema';
import {
  OIDC_CONFIRM_COOKIE,
  OIDC_CONFIRM_TTL_SECONDS,
  OIDC_STATE_COOKIE,
  OIDC_STATE_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  TOTP_PENDING_COOKIE,
  TOTP_PENDING_TTL_SECONDS,
  signOidcConfirm,
  verifyOidcConfirm,
  type OidcConfirmPayload,
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
 * Cookie-хелперы сессии (через next/headers).
 *
 * `secure` теперь ВСЕГДА true, а не только в проде: все наши cookie носят
 * префикс `__Host-`, а он требует Secure — без него браузер молча выбрасывает
 * cookie, и вход «не работает» без единой ошибки. На `http://localhost`
 * браузеры Secure-cookie принимают, поэтому разработка не ломается.
 */

const COOKIE_ATTRS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: true,
} as const;

/**
 * Гашение cookie ПЕРЕЗАПИСЬЮ, а не `.delete()`.
 *
 * Под префиксом `__Host-` удаление обязано само удовлетворять префиксу
 * (Secure + Path=/ + без Domain), иначе браузер его отвергает — и cookie
 * переживает то, что должно было её убить. Для состояния ЕСА это тихо снимало
 * бы одноразовость, на которой держится вся конструкция: `state`/`nonce`/PKCE
 * защищают ровно потому, что состояние гаснет в момент обмена. Тест такое не
 * поймает никогда: серверный код на месте, отвергает только браузер.
 */
async function killCookie(name: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(name, '', { ...COOKIE_ATTRS, maxAge: 0 });
}

export async function setSessionCookie(uid: number, mfa: boolean, epoch: number): Promise<void> {
  const token = await signSession(uid, mfa, epoch);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, { ...COOKIE_ATTRS, maxAge: SESSION_TTL_SECONDS });
}

/**
 * Перевыпуск cookie с текущим поколением сессии (аудит #057 R2).
 *
 * Операции, двигающие счётчик поколений (смена пароля, сброс пароля, включение и
 * выключение 2FA), убивают ВСЕ ранее выданные токены — иначе механизм отзыва не работал
 * бы. Но текущий браузер ходил легитимно: разлогинивать человека, который только что
 * подтвердил смену пароля, не нужно. Здесь epoch берётся из БД ПОСЛЕ инкремента, то есть
 * cookie получает новое поколение и продолжает работать.
 *
 * Отдельный браузер (второе устройство) закономерно останется разлогиненным — это и есть
 * смысл механизма: «если это сделал не я, я хочу, чтобы всё другое отвалилось».
 */
export async function rotateSessionCookie(userId: number): Promise<void> {
  const epoch = await currentSessionEpoch(userId);
  if (epoch === null) return;
  const payload = await readSessionPayload();
  await setSessionCookie(userId, payload?.mfa ?? false, epoch);
}

export async function clearSessionCookie(): Promise<void> {
  await killCookie(SESSION_COOKIE);
}

async function readSessionToken(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE)?.value;
}

export async function readSessionUid(): Promise<number | null> {
  return verifySession(await readSessionToken());
}

/** Полный payload сессии (uid + mfa + epoch) — для гейта /secrets и отзыва. */
export async function readSessionPayload(): Promise<SessionPayload | null> {
  return verifySessionPayload(await readSessionToken());
}

/**
 * Поколение сессии учётки в БД; null — учётки нет.
 *
 * Обязательный параметр при выдаче cookie, поэтому экспортируется: три места входа
 * (`login`, `totp`, OIDC callback) обязаны чеканить токен ТЕКУЩЕГО поколения, а не
 * угадывать. Значение по умолчанию здесь означало бы токен поколения 0 — тот самый,
 * который не отзывается до первого инкремента.
 */
export async function currentSessionEpoch(userId: number): Promise<number | null> {
  const [row] = await db
    .select({ epoch: authUser.sessionEpoch })
    .from(authUser)
    .where(eq(authUser.id, userId))
    .limit(1);
  return row?.epoch ?? null;
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
  await killCookie(TOTP_PENDING_COOKIE);
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
  await killCookie(OIDC_STATE_COOKIE);
}

// --- Подтверждение привязки (между возвратом из ЕСА и самой привязкой) --------

export async function setOidcConfirmCookie(payload: OidcConfirmPayload): Promise<void> {
  const token = await signOidcConfirm(payload);
  const cookieStore = await cookies();
  cookieStore.set(OIDC_CONFIRM_COOKIE, token, {
    ...COOKIE_ATTRS,
    maxAge: OIDC_CONFIRM_TTL_SECONDS,
  });
}

export async function readOidcConfirm(): Promise<OidcConfirmPayload | null> {
  const cookieStore = await cookies();
  return verifyOidcConfirm(cookieStore.get(OIDC_CONFIRM_COOKIE)?.value);
}

export async function clearOidcConfirmCookie(): Promise<void> {
  await killCookie(OIDC_CONFIRM_COOKIE);
}
