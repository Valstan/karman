/**
 * Защита входа от перебора: блокировка после N неудач подряд по ключу
 * `username|ip` в скользящем окне. In-memory, per-instance (на проде единственный
 * инстанс standalone — достаточно; при масштабировании — общий стор, как и
 * rate-limit секретов). Date.now() — рантайм-время сервера.
 *
 * ## Два измерения, а не одно (аудит #057, R1)
 *
 * Изначально счётчик жил только на паре `логин|IP`. IP здесь брали из
 * `X-Forwarded-For` первым элементом — то есть из того, что подставил клиент, а nginx
 * этот заголовок дополняет, а не перезаписывает. Ротация заголовка обнуляла счётчик на
 * каждом запросе, и блокировка (10 попыток / 15 минут) не срабатывала никогда. Теперь
 * IP берётся из доверенного заголовка (`lib/api/client-ip.ts`), но и этого мало: счётчик
 * по логину существует **независимо** от адреса, поэтому перебор с одного места и
 * перебор с тысячи мест упираются в один и тот же предел.
 *
 * ## Уборка (аудит #057, D3)
 *
 * `states` — обычный `Map`, и раньше запись удалялась только успешным входом по тому же
 * ключу. Неудачные попытки с подделанным IP накапливались вечно: анонимный трафик создавал
 * ключ на каждый запрос. Теперь просроченное вычищается, а при превышении порога карта
 * сбрасывается целиком — дешевле и предсказуемее, чем расти до OOM при `MemoryMax=512M`.
 */

type FailState = { count: number; windowStart: number; lockedUntil: number };

const WINDOW_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;
const MAX_FAILURES = 10;
/** Анонимный вход с чужим логином обязан быть ограничен ДО похода в БД (pbkdf2). */
const MAX_ACCOUNT_FAILURES = 50;
/** Сброс целиком при переполнении: лучше одно лишнее окно, чем нехватка памяти. */
const MAX_ENTRIES = 20_000;

const states = new Map<string, FailState>();
const accountStates = new Map<string, FailState>();

export function loginGuardKey(username: string, ip: string | null): string {
  return `${username.trim().toLowerCase()}|${ip ?? '-'}`;
}

/** Вычищает просроченное; при переполнении — сбрасывает карту целиком. */
function sweep(store: Map<string, FailState>, now: number): void {
  if (store.size <= MAX_ENTRIES) {
    for (const [key, state] of store) {
      if (now >= state.lockedUntil && now - state.windowStart >= WINDOW_MS) {
        store.delete(key);
      }
    }
    return;
  }
  store.clear();
}

/** true — вход разрешён; false — ключ заблокирован (lockout ещё действует). */
export function loginAllowed(key: string, account: string, now: number = Date.now()): boolean {
  sweep(states, now);
  sweep(accountStates, now);
  const s = states.get(key);
  const a = accountStates.get(account);
  return !(s && now < s.lockedUntil) && !(a && now < a.lockedUntil);
}

/** Регистрирует неудачу; возвращает true, если этот провал вызвал блокировку. */
export function registerFailure(key: string, account: string, now: number = Date.now()): boolean {
  sweep(states, now);
  sweep(accountStates, now);

  const bumped = bump(states, key, MAX_FAILURES, now);
  const accountLocked = bump(accountStates, account, MAX_ACCOUNT_FAILURES, now);
  return bumped || accountLocked;
}

function bump(store: Map<string, FailState>, key: string, limit: number, now: number): boolean {
  const s = store.get(key);
  if (!s || now - s.windowStart >= WINDOW_MS) {
    store.set(key, { count: 1, windowStart: now, lockedUntil: 0 });
    return false;
  }
  s.count += 1;
  if (s.count >= limit && now >= s.lockedUntil) {
    s.lockedUntil = now + LOCK_MS;
    s.count = 0;
    s.windowStart = now;
    return true;
  }
  return false;
}

/** Успешный вход сбрасывает счётчик неудач по адресу и по логину. */
export function registerSuccess(key: string, account: string): void {
  states.delete(key);
  accountStates.delete(account);
}