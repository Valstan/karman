import 'server-only';
import { signinStatus, SIGNIN_STATUS_CLAIMABLE } from '@/lib/minimax/oauth';
import { OWNER_TIMEZONE } from '@/lib/minimax/panel';
import { liveAccessToken } from '@/lib/services/account-tokens';
import {
  PANEL_STATE_TTL_MS,
  deletePanelState,
  isFreshPanelState,
  readPanelStates,
  writePanelState,
} from '@/lib/accounts/panel-state';

/**
 * Сверка суток с панелью MiniMax — источник правды о том, у кого есть очки.
 *
 * ## Зачем это (15.11, доработано 16.11)
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
 * Живая проба 16.11 (аккаунты 48 и 47, активированы накануне в 22:55 МСК):
 * круг из семи клеток, где **день 1 — забрано (status 3), день 2 — сегодня и
 * его можно забрать (status 2, 400 очков)**, дни 3–7 — не начались (status 1).
 * Аккаунты, активированные сегодня (63, 85): день 1 — сегодня и забрано
 * (status 3). То есть у панели ровно два состояния на сегодня: **очки есть**
 * (status 2) или **очки сожжены** (status 3).
 *
 * ## Что из этого берём
 *
 * - **выдача**: аккаунт отдаём, только если панель говорит, что его клетка
 *   «сегодня» забираема (status 2) — в поясе ПОТРЕБИТЕЛЯ. Ответ «не знаю»
 *   (панель не ответила или состояние протухло) → решает наша эвристика
 *   ночной границы;
 * - **возврат в оборот** (заказ владельца 16.11: «сделать аккаунты активными,
 *   когда очки появятся»): панель сказала «очки есть» — аккаунт снова свободен,
 *   даже если наша эвристика считает его сожжённым до ночного сброса;
 * - **список владельца**: показываем, у кого очки реально есть.
 *
 * ## Где живёт состояние
 *
 * В БД (`account_panel_state`), а не в памяти процесса: память не переживала
 * рестарт, и — главное — action и страница попадали в разные чанки Turbopack,
 * то есть видели РАЗНОЕ состояние одних и тех же аккаунтов. Подробности —
 * `lib/accounts/panel-state.ts`.
 */

/** Пояс владельца: панель программирования — это комп владельца. */
export { OWNER_TIMEZONE, DEFAULT_TIMEZONE, timezoneForRoom } from '@/lib/minimax/panel';

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

/** Сколько живёт прочитанное состояние, прежде чем считать его устаревшим. */
export const DAILY_STATE_TTL_MS = PANEL_STATE_TTL_MS;

/** Статус клетки «можно забрать» — переиспользуем константу панели. */
export { SIGNIN_STATUS_CLAIMABLE };

/**
 * Прочитать состояние суток аккаунта с панели MiniMax (только чтение).
 *
 * Возвращает null, если панель не ответила или access непригоден: это «не знаю»,
 * а не «очков нет» — решение в этом случае принимает вызывающий.
 *
 * Свежее состояние из БД возвращается без похода в MiniMax; протухшее или
 * отсутствующее — читается заново и записывается в БД.
 */
export async function dailyStateFor(
  accountId: number,
  timezoneId: string,
  now: Date = new Date(),
  options: { force?: boolean; userId: number },
): Promise<DailyState | null> {
  if (!options.force) {
    const stored = await readPanelStates(options.userId, timezoneId, [accountId]);
    const state = stored.get(accountId) ?? null;
    if (isFreshPanelState(state, now)) return toDailyState(state!);
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
    // Отметка времени — момент ПРОЧТЕНИЯ, а не момент начала сверки: иначе
    // весь пул получил бы одну и ту же отметку и состояние старело бы заново
    // от общего начала (сотня аккаунтов, минуты на чтение).
    checked_at: new Date().toISOString(),
  };
  await writePanelState(options.userId, accountId, timezoneId, {
    cell_no: state.cell_no,
    status: state.status,
    points: state.points,
    can_claim: state.can_claim,
    checked_at: state.checked_at,
  });
  return state;
}

/**
 * Все прочитанные состояния владельца в поясе (для интерфейса).
 *
 * Возвращаются ВСЕ — и свежие, и протухшие: интерфейсу важно показать, когда
 * панель читали, чтобы не выдавать «очки сожжены» за сегодняшнюю правду.
 */
export async function dailyStates(
  userId: number,
  timezoneId: string = OWNER_TIMEZONE,
): Promise<Map<number, DailyState>> {
  const stored = await readPanelStates(userId, timezoneId);
  const out = new Map<number, DailyState>();
  for (const [accountId, state] of stored) out.set(accountId, toDailyState(state));
  return out;
}

/**
 * Забыть состояние аккаунта (мы только что отдали его — очки забраны).
 *
 * Забываем во всех поясах: очки сгорели у аккаунта, а не «в одном из суток».
 * Пока состояния нет, действует эвристика ночной границы — а она после
 * активации говорит «сожжён» (аккаунт только что активирован).
 */
export async function forgetDailyState(accountId: number): Promise<void> {
  await deletePanelState(accountId);
}


function toDailyState(state: {
  account_id: number;
  timezone_id: string;
  cell_no: number;
  status: number;
  points: number;
  can_claim: boolean;
  checked_at: string;
}): DailyState {
  return {
    account_id: state.account_id,
    timezone_id: state.timezone_id,
    cell_no: state.cell_no,
    status: state.status,
    points: state.points,
    can_claim: state.can_claim,
    checked_at: state.checked_at,
  };
}
