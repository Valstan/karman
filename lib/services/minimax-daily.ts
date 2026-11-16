import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { accountToken } from '@/lib/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import { signinStatus, SIGNIN_STATUS_CLAIMABLE } from '@/lib/minimax/oauth';
import { liveAccessToken } from '@/lib/services/account-tokens';

/**
 * Сверка суток с панелью MiniMax — источник правды о том, у кого есть очки.
 *
 * ## Зачем это (15.11)
 *
 * Наша «ночная граница» (аккаунт сожжён до ночного сброса) — ЭВРИСТИКА: сутки
 * MiniMax считаются по **часовому поясу запроса** (панель требует `timezone_id`),
 * а мы точного часа не знаем. Из-за этого в полночь 15.11 пятнадцать аккаунтов
 * подряд отказали с «insufficient balance (1008)»: у Сарафана «сегодня» ещё были
 * вчерашние сутки, клетка была забрана, а очков не давали.
 *
 * ## Проба панели ничего не тратит
 *
 * `GET https://agent.minimax.io/minimax-cloud/api/v1/signin/status?timezone_id=…`
 * — ТОЛЬКО ЧТЕНИЕ. Очки начисляются `claim`ом (автоматически, когда рантайм
 * начал работать под аккаунтом). Значит панель можно читать хоть для каждого
 * аккаунта хоть каждый час — и точно знать, кто готов к выдаче.
 *
 * Живая проверка 15.11 (аккаунт #3, access обновлён по refresh): день 1–4 —
 * забрано, **день 5 — status 2 «можно забрать», 400 очков**, дни 6–7 не начались.
 * То есть клетка «сегодня» открыта, очки на месте — и мы их не тратим.
 *
 * ## Что из этого берём
 *
 * - **выдача**: аккаунт отдаём только если панель говорит, что его клетка «сегодня»
 *   забираема (status 2) — в поясе ПОТРЕБИТЕЛЯ. Ответ «не знаю» (панель не
 *   ответила) → решает наша эвристика ночной границы;
 * - **список владельца**: показываем, у кого очки реально есть (кэш состояния).
 */
export const OWNER_TIMEZONE = 'Europe/Moscow';

/**
 * Пояс по умолчанию для потребителя — «поздний» из двух возможных.
 *
 * Сутки MiniMax считаются по поясу запроса, поэтому в полночь МСК один и тот же
 * аккаунт для панели владельца (Europe/Moscow) уже «завтрашний», а для потребителя
 * на UTC — ещё «сегодняшний» (его сутки сменятся в 03:00 МСК). Для выдачи
 * берём ПОЗДНИЙ пояс: тогда очки гарантированно есть у обеих сторон.
 */
export const DEFAULT_TIMEZONE = 'UTC';

/** Пояс потребителя по комнате: панель программирования — это комп владельца. */
export function timezoneForRoom(roomSlug: string): string {
  if (roomSlug === 'brain') return OWNER_TIMEZONE;
  return DEFAULT_TIMEZONE;
}

/** Состояние суток аккаунта, прочитанное с панели MiniMax. */
export type DailyState = {
  account_id: number;
  timezone_id: string;
  /** Номер клетки в недельном круге (1..7). */
  cell_no: number;
  /** 1 — не начался, 2 — можно забрать, 3 — забрано, 4 — недоступен. */
  status: number;
  /** Сколько очков даст сегодняшняя клетка. */
  points: number;
  /** Можно ли забрать очки прямо сейчас. */
  can_claim: boolean;
  /** Когда прочитали (ISO). */
  checked_at: string;
};

/** Кэш прочитанного состояния: ключ `аккаунт:пояс`. */
const cache = new Map<string, DailyState>();

/** Сколько живёт прочитанное состояние, прежде чем считать его устаревшим. */
export const DAILY_STATE_TTL_MS = 30 * 60_000;

function key(accountId: number, timezoneId: string): string {
  return `${accountId}:${timezoneId}`;
}

/** Прочитанное состояние из кэша, если оно ещё свежее. */
export function cachedDailyState(
  accountId: number,
  timezoneId: string,
  maxAgeMs: number = DAILY_STATE_TTL_MS,
  now: Date = new Date(),
): DailyState | null {
  const state = cache.get(key(accountId, timezoneId));
  if (!state) return null;
  if (new Date(state.checked_at).getTime() + maxAgeMs < now.getTime()) return null;
  return state;
}

/** Все прочитанные состояния в поясе (для интерфейса). */
export function dailyStates(timezoneId: string = OWNER_TIMEZONE): Map<number, DailyState> {
  const out = new Map<number, DailyState>();
  for (const state of cache.values()) {
    if (state.timezone_id === timezoneId) out.set(state.account_id, state);
  }
  return out;
}

/**
 * Прочитать состояние суток аккаунта с панели MiniMax (только чтение).
 *
 * Возвращает null, если панель не ответила или access непригоден: это «не знаю»,
 * а не «очков нет» — решение в этом случае принимает вызывающий.
 */
export async function dailyStateFor(
  accountId: number,
  timezoneId: string,
  now: Date = new Date(),
  options: { force?: boolean } = {},
): Promise<DailyState | null> {
  if (!options.force) {
    const cached = cachedDailyState(accountId, timezoneId, DAILY_STATE_TTL_MS, now);
    if (cached) return cached;
  }

  const access = await liveAccessToken(accountId, now);
  if (!access) return null;

  const status = await signinStatus(access, timezoneId);
  if (!status.ok) return null;

  const today = status.data.today;
  const state: DailyState = {
    account_id: accountId,
    timezone_id: timezoneId,
    cell_no: today?.day_no ?? 0,
    status: today?.status ?? 0,
    points: status.data.points,
    can_claim: status.data.canClaim,
    checked_at: now.toISOString(),
  };
  cache.set(key(accountId, timezoneId), state);
  return state;
}

/** Забыть состояние аккаунта (мы только что отдали его — очки забраны). */
export function forgetDailyState(accountId: number, timezoneId: string): void {
  cache.delete(key(accountId, timezoneId));
}

/**
 * Прочитать состояние суток ВСЕХ аккаунтов, у которых есть пара токенов.
 *
 * Тяжёлая операция (сотни вызовов MiniMax, часть — с обновлением цепочки по
 * refresh), поэтому её запускает владелец кнопкой, а не выдача: выдаче нужна
 * проверка одного аккаунта перед выдачей, а не всего пула.
 */
export async function syncDailyStates(
  user: SessionUser,
  timezoneId: string = OWNER_TIMEZONE,
  now: Date = new Date(),
): Promise<{ checked: number; claimable: number; failed: number }> {
  const rows = await db
    .select({ accountId: accountToken.accountId })
    .from(accountToken)
    .where(eq(accountToken.userId, user.id));

  let checked = 0;
  let claimable = 0;
  let failed = 0;
  // Пачками по пять: так мы не долбим вендор и не упираемся в его лимиты.
  for (let i = 0; i < rows.length; i += 5) {
    const batch = rows.slice(i, i + 5);
    const results = await Promise.all(
      batch.map((row) =>
        dailyStateFor(row.accountId, timezoneId, now, { force: true }).catch(() => null),
      ),
    );
    for (const state of results) {
      if (!state) {
        failed += 1;
        continue;
      }
      checked += 1;
      if (state.can_claim) claimable += 1;
    }
  }
  return { checked, claimable, failed };
}

/** Статус клетки «можно забрать» — переиспользуем константу панели. */
export { SIGNIN_STATUS_CLAIMABLE };
