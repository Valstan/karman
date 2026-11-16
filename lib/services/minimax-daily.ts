import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { accountToken } from '@/lib/db/schema';
import { signinStatus, SIGNIN_STATUS_CLAIMABLE } from '@/lib/minimax/oauth';
import { DEFAULT_TIMEZONE, OWNER_TIMEZONE } from '@/lib/minimax/panel';
import { liveAccessToken } from '@/lib/services/account-tokens';
import {
  PANEL_STATE_TTL_MS,
  deletePanelState,
  isFreshPanelState,
  readPanelStates,
  writePanelState,
  type PanelState,
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
    checked_at: now.toISOString(),
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

/**
 * Прочитать состояние суток ВСЕХ аккаунтов, у которых есть пара токенов.
 *
 * Тяжёлая операция (сотни вызовов MiniMax, часть — с обновлением цепочки по
 * refresh), поэтому её запускает либо владелец кнопкой, либо автосверка по
 * таймеру: выдаче нужна проверка одного аккаунта перед выдачей, а не всего
 * пула.
 *
 * `force` — обновить всё, даже свежее (кнопка владельца «Сверить сутки с
 * MiniMax»); без него обновляется только протухшее (автосверка).
 */
export async function syncDailyStates(
  userId: number,
  timezoneId: string = OWNER_TIMEZONE,
  now: Date = new Date(),
  options: { force?: boolean; budgetMs?: number } = {},
): Promise<{ checked: number; skipped: number; claimable: number; failed: number }> {
  const rows = await db
    .select({ accountId: accountToken.accountId })
    .from(accountToken)
    .where(eq(accountToken.userId, userId));

  const stored: Map<number, PanelState> = options.force
    ? new Map()
    : await readPanelStates(userId, timezoneId);

  let checked = 0;
  let skipped = 0;
  let claimable = 0;
  let failed = 0;
  // Бюджет времени: вендор может подвисать, а сверка идёт в фоне. Не начали —
  // доделаем следующим тиком: протухшие состояния обновляются первыми.
  const deadline = options.budgetMs ? Date.now() + options.budgetMs : null;
  // Пачками по пять: так мы не долбим вендор и не упираемся в его лимиты.
  for (let i = 0; i < rows.length; i += 5) {
    if (deadline !== null && Date.now() > deadline) break;
    const batch = rows.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(async (row) => {
        if (!options.force) {
          const state = stored.get(row.accountId) ?? null;
          if (isFreshPanelState(state, now)) {
            return { kind: 'skipped' as const, claimable: state!.can_claim };
          }
        }
        const state = await dailyStateFor(row.accountId, timezoneId, now, {
          force: true,
          userId,
        }).catch(() => null);
        return { kind: 'read' as const, state };
      }),
    );
    for (const result of results) {
      if (result.kind === 'skipped') {
        skipped += 1;
        if (result.claimable) claimable += 1;
        continue;
      }
      if (!result.state) {
        failed += 1;
        continue;
      }
      checked += 1;
      if (result.state.can_claim) claimable += 1;
    }
  }
  return { checked, skipped, claimable, failed };
}

/**
 * Автосверка: прочитать панель по ВСЕМ аккаунтам с парой токенов — у всех
 * владельцев и в обоих рабочих поясах (панель владельца и панель потребителя).
 *
 * Это и есть «аккаунты активны, когда очки появятся» без участия человека:
 * после ночного сброса MiniMax панель снова говорит «очки есть», и аккаунты
 * возвращаются в оборот сами.
 */
export async function sweepPanelStates(
  now: Date = new Date(),
  options: { force?: boolean; budgetMs?: number } = {},
): Promise<{
  owners: number;
  checked: number;
  skipped: number;
  claimable: number;
  failed: number;
  /** True — сверка не уложилась в бюджет: остаток доедет следующим тиком. */
  stopped: boolean;
}> {
  const owners = await db.selectDistinct({ userId: accountToken.userId }).from(accountToken);
  const deadline = Date.now() + (options.budgetMs ?? 120_000);
  let checked = 0;
  let skipped = 0;
  let claimable = 0;
  let failed = 0;
  let stopped = false;
  for (const owner of owners) {
    for (const timezoneId of [OWNER_TIMEZONE, DEFAULT_TIMEZONE]) {
      if (Date.now() > deadline) {
        stopped = true;
        break;
      }
      const result = await syncDailyStates(owner.userId, timezoneId, now, {
        force: options.force,
        // Остаток бюджета: одна пара «владелец + пояс» не должна съесть весь.
        budgetMs: Math.max(0, deadline - Date.now()),
      }).catch(() => ({
        checked: 0,
        skipped: 0,
        claimable: 0,
        failed: 1,
      }));
      checked += result.checked;
      skipped += result.skipped;
      claimable += result.claimable;
      failed += result.failed;
    }
    if (stopped) break;
  }
  return { owners: owners.length, checked, skipped, claimable, failed, stopped };
}

/** Строка состояния из БД — в форму сервиса. */
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
