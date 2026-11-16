import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { accountPanelState, accountsAccount } from '@/lib/db/schema';
import { PANEL_STATUS_CLAIMED } from '@/lib/minimax/panel';

/**
 * Состояние суток аккаунта по панели MiniMax — чтение и запись в БД.
 *
 * ## Зачем отдельный слой
 *
 * Состояние панели — это ответ вендора «есть ли у аккаунта сегодня очки». Он
 * нужен трём местам: выдаче аккаунта (`lib/services/minimax.ts`), странице
 * владельца (`app/(app)/minimax/page.tsx`) и автосверке по таймеру. Раньше оно
 * жило в `Map` в памяти процесса — и это была дыра:
 *
 * - состояние не переживало рестарт сервиса;
 * - action и страница попадали в РАЗНЫЕ чанки Turbopack, то есть видели разное
 *   состояние одних и тех же аккаунтов (страница показывала «очки есть» там,
 *   где выдача уже считала аккаунт занятым, и наоборот).
 *
 * Теперь состояние лежит в БД (`account_panel_state`, миграция
 * 0034_account_panel_state.sql) — его видят все трое и оно одинаково.
 *
 * ## Почему ключ — «аккаунт + пояс»
 *
 * Сутки MiniMax считаются по часовому поясу ЗАПРОСА. У панели владельца
 * (Europe/Moscow) и у панели проекта (UTC) «сегодня» — разные дни в ночном
 * окне между 00:00 и 03:00 МСК; ровно в это окно 15.11 пятнадцать аккаунтов
 * подряд отказали с «insufficient balance (1008)». Смешивать два ответа нельзя,
 * поэтому состояние хранится по паре «аккаунт + пояс», а выдача берёт ответ для
 * пояса ПОТРЕБИТЕЛЯ.
 *
 * ## Свежесть — часть правды
 *
 * Панель меняется: очки сгорают, ночь приносит новые, владелец активирует
 * аккаунт сам. Поэтому у каждого состояния есть `checked_at`, и ПРОТУХШЕЕ
 * состояние — это «не знаю», а не «очков нет». Пока состояние свежее, оно —
 * источник правды; как только протухло, решает старая эвристика ночного сброса
 * (`lib/accounts/rotation.ts`), а автосверка обновит состояние в ближайшие
 * минуты.
 *
 * ## Инварианты
 *
 * - одна строка на пару «аккаунт + пояс»: «очки есть/очки сожжены» — свойство
 *   аккаунта В ЕГО СУТКАХ;
 * - состояние НЕ удаляется, когда очки сожгли: следующая сверка его обновит, а
 *   до неё протухшее состояние честно значит «не знаю»;
 * - удаляется строка только вместе с аккаунтом (`ON DELETE CASCADE`).
 */

/** Состояние суток аккаунта, прочитанное с панели MiniMax. */
export type PanelState = {
  account_id: number;
  /** Пояс, которым спрашивали панель. */
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

/**
 * Сколько живёт прочитанное состояние, прежде чем оно считается устаревшим.
 *
 * Полчаса — с запасом на ночной сброс MiniMax (час сброса точно не известен,
 * см. `lib/accounts/rotation.ts`): состояние «очки есть» переживает сброс
 * корректно (после сброса очки снова есть), а состояние «очки сожжены» после
 * сброса становится неверным — и вот его протухание нас спасёт.
 */
export const PANEL_STATE_TTL_MS = 30 * 60_000;

/**
 * После какого возраста состояния автосверка его обновляет.
 *
 * Это НЕ то же, что срок годности: срок (полчаса) — сколько ответ панели
 * годен для решений пула, а возраст обновления — как часто мы перечитываем
 * панель. Держим обновление вдвое чаще срока годности, иначе состояние
 * подползало бы к границе (сверка пропускает «ещё свежее», а пул уже считает
 * «не знаю») — и аккаунты, которым панель вернула очки, выпадали бы из оборота
 * на треть времени.
 */
export const PANEL_REFRESH_AGE_MS = 15 * 60_000;

/** Свежее ли состояние (по `checked_at`). */
export function isFreshPanelState(
  state: Pick<PanelState, 'checked_at'> | null | undefined,
  now: Date = new Date(),
  ttlMs: number = PANEL_STATE_TTL_MS,
): boolean {
  if (!state) return false;
  const checked = new Date(state.checked_at).getTime();
  if (Number.isNaN(checked)) return false;
  return checked + ttlMs >= now.getTime();
}

/**
 * Состояния панели по аккаунтам владельца — из БД.
 *
 * `accountIds` — сузить до конкретных аккаунтов (иначе все аккаунты владельца).
 */
export async function readPanelStates(
  userId: number,
  timezoneId: string,
  accountIds?: number[],
): Promise<Map<number, PanelState>> {
  const rows = await db
    .select({
      accountId: accountPanelState.accountId,
      timezoneId: accountPanelState.timezoneId,
      cellNo: accountPanelState.cellNo,
      status: accountPanelState.status,
      points: accountPanelState.points,
      canClaim: accountPanelState.canClaim,
      checkedAt: accountPanelState.checkedAt,
    })
    .from(accountPanelState)
    .where(
      and(
        eq(accountPanelState.userId, userId),
        eq(accountPanelState.timezoneId, timezoneId),
        ...(accountIds && accountIds.length
          ? [inArray(accountPanelState.accountId, accountIds)]
          : []),
      ),
    );

  const out = new Map<number, PanelState>();
  for (const row of rows) {
    out.set(row.accountId, {
      account_id: row.accountId,
      timezone_id: row.timezoneId,
      cell_no: row.cellNo,
      status: row.status,
      points: row.points,
      can_claim: row.canClaim,
      checked_at: row.checkedAt,
    });
  }
  return out;
}

/**
 * Записать прочитанное состояние панели (upsert по паре «аккаунт + пояс»).
 *
 * Запись нужна и после «очки сожжены»: состояние «сожжено» — тоже ответ
 * панели, и без него аккаунт зря гонялся бы в выдачу.
 */
export async function writePanelState(
  userId: number,
  accountId: number,
  timezoneId: string,
  state: {
    cell_no: number;
    status: number;
    points: number;
    can_claim: boolean;
    checked_at: string;
  },
): Promise<void> {
  await db
    .insert(accountPanelState)
    .values({
      accountId,
      timezoneId,
      userId,
      cellNo: state.cell_no,
      status: state.status,
      points: state.points,
      canClaim: state.can_claim,
      checkedAt: state.checked_at,
      updatedAt: state.checked_at,
    })
    .onConflictDoUpdate({
      target: [accountPanelState.accountId, accountPanelState.timezoneId],
      set: {
        userId,
        cellNo: state.cell_no,
        status: state.status,
        points: state.points,
        canClaim: state.can_claim,
        checkedAt: state.checked_at,
        updatedAt: state.checked_at,
      },
    });
}

/**
 * Забыть состояние панели аккаунта — очки только что сгорели (выдали аккаунт
 * или владелец активировал его сам).
 *
 * Смысл: панель ещё не знает, что очки забрали, а мы уже знаем. Оставить
 * «очки есть» — значит отдать аккаунт, у которого очков нет.
 *
 * Без пояса — забыть во всех поясах: очки сгорели для аккаунта, а не «в одном
 * из суток».
 */
export async function deletePanelState(accountId: number, timezoneId?: string): Promise<void> {
  await db
    .delete(accountPanelState)
    .where(
      timezoneId
        ? and(
            eq(accountPanelState.accountId, accountId),
            eq(accountPanelState.timezoneId, timezoneId),
          )
        : eq(accountPanelState.accountId, accountId),
    );
}

/**
 * Пометить ответ панели «очки сожжены» — после того, как аккаунт отдан
 * потребителю или активирован владельцем.
 *
 * ## Почему не удаляем ответ, а помечаем
 *
 * Раньше ответ панели УДАЛЯЛСЯ, и строка аккаунта снова показывала модель по
 * датам. А модель разошлась с панелью: живая сверка 16.11 — клетка панели и
 * клетка модели расходятся у 73 аккаунтов из 109, а класс очков (400 или
 * 1000) — у 48. То есть в каталоге появлялись «свободные 1000-очковые
 * аккаунты», которые на деле давали 400: обещание расходилось с фактом, и
 * Мозг получал «тысячные», которые тысячными не были.
 *
 * Помечаем — и в каталоге сразу видна правда («очки сожжены — ждём сброса»),
 * а не догадка модели. Через автосверку панель ответит заново: после её
 * ночного сброса — «очки есть», и аккаунт вернётся в оборот сам.
 *
 * Номер клетки сохраняем: это клетка, которая была забрана.
 */
export async function markPanelStatesClaimed(
  accountId: number,
  now: Date = new Date(),
): Promise<void> {
  const stamp = now.toISOString();
  await db
    .update(accountPanelState)
    .set({
      status: PANEL_STATUS_CLAIMED,
      canClaim: false,
      points: 0,
      checkedAt: stamp,
      updatedAt: stamp,
    })
    .where(eq(accountPanelState.accountId, accountId));
}

/**
 * Владелец аккаунта — нужен для записи состояния (в строке лежит `user_id`).
 *
 * Отдельный запрос, а не джойн: запись состояния идёт пачками при сверке, и
 * владелец там известен заранее (см. `syncDailyStates`).
 */
export async function accountOwnerId(accountId: number): Promise<number | null> {
  const [row] = await db
    .select({ userId: accountsAccount.userId })
    .from(accountsAccount)
    .where(eq(accountsAccount.id, accountId))
    .limit(1);
  return row?.userId ?? null;
}
