/**
 * Защита входа от перебора: блокировка после N неудач подряд по ключу
 * `username|ip` в скользящем окне. In-memory, per-instance (на Боксе 1 один
 * инстанс standalone — достаточно; при масштабировании — общий стор, как и
 * rate-limit секретов). Date.now() — рантайм-время сервера.
 */

type FailState = { count: number; windowStart: number; lockedUntil: number };

const WINDOW_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;
const MAX_FAILURES = 10;
const states = new Map<string, FailState>();

export function loginGuardKey(username: string, ip: string | null): string {
  return `${username.trim().toLowerCase()}|${ip ?? '-'}`;
}

/** true — вход разрешён; false — ключ заблокирован (lockout ещё действует). */
export function loginAllowed(key: string, now: number = Date.now()): boolean {
  const s = states.get(key);
  return !s || now >= s.lockedUntil;
}

/** Регистрирует неудачу; возвращает true, если этот провал вызвал блокировку. */
export function registerFailure(key: string, now: number = Date.now()): boolean {
  const s = states.get(key);
  if (!s || now - s.windowStart >= WINDOW_MS) {
    states.set(key, { count: 1, windowStart: now, lockedUntil: 0 });
    return false;
  }
  s.count += 1;
  if (s.count >= MAX_FAILURES && now >= s.lockedUntil) {
    s.lockedUntil = now + LOCK_MS;
    s.count = 0;
    s.windowStart = now;
    return true;
  }
  return false;
}

/** Успешный вход сбрасывает счётчик неудач. */
export function registerSuccess(key: string): void {
  states.delete(key);
}
