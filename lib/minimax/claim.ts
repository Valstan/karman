/**
 * Забор суточного бонуса MiniMax (`POST /signin/claim`).
 *
 * ## Что это
 *
 * У каждого аккаунта — недельный круг из семи клеток; сегодняшняя клетка даёт
 * 400 или 1000 очков, и **забрать его можно один раз в сутки**. Забором называется
 * именно `claim`: он переводит сегодняшнюю клетку в состояние «забрано» и начисляет
 * очки на аккаунт.
 *
 * ## Ключевые свойства (проверено живой пробой 18.11)
 *
 * 1. **Забор идемпотентен в сутки.** Первый `claim` → `claim_result = 1` («забрали»),
 *    повтор в те же сутки → `claim_result = 2` («уже получено») с тем же `claim_id`.
 *    Значит обход аккаунтов можно гонять хоть каждые пять минут — лишнего не возьмётся.
 * 2. **Забор очки НЕ ТРАТИТ — он их начисляет.** Сразу после забора клетка имеет
 *    `status = 3` (забрано), но `points = 400`: очки целы, они ждут потребителя.
 *    Тратит их работа рантайма под аккаунтом. Именно поэтому забор можно делать
 *    заранее (ночью/утром), а потребитель потом заберёт те же очки: повторный `claim`
 *    отдаёт `points = 400`, и рантайм получает полную порцию.
 * 3. **Повтор возвращает остаток, а не ноль.** Это отличает «забрали, но не потратили»
 *    от «забрали и потратили»: в первом случае `points` ненулевой.
 *
 * ## Зачем нам это (заказ владельца 18.11)
 *
 * «Каждые сутки пройтись по всем аккаунтам и активировать на них бонусы, записывать у
 * себя, у кого сколько очков сегодня активировалось, а потом в течение дня раздавать эти
 * аккаунты по запросам, зная, по сколько очков отдаётся». Побочная выгода — серия дней
 * подряд у аккаунта не рвётся: клетка сдвигается у всех, даже если аккаунт никто не взял.
 *
 * ## Часовой пояс
 *
 * Сутки MiniMax считаются по поясу ЗАПРОСА, поэтому в запрос забора пояс тоже
 * обязателен (без него вендор отвечает «invalid timezone_id»). Мы забираем по
 * московскому поясу — так «сегодня» совпадает с московскими сутками владельца.
 */

import type { SigninDay } from './oauth';

/** Ответ вендора на забор бонуса. */
export type ClaimResult = {
  /** 1 — забрали сейчас, 2 — уже получено сегодня (идемпотентный повтор). */
  claim_result: number;
  /** Идентификатор забора (один на сутки). */
  claim_id: string | null;
  /** Номер клетки в недельном круге (1..7). */
  day_no: number | null;
  /** Сколько очков даёт сегодняшняя клетка (400 / 1000). */
  points: number | null;
  /** До какого момента бонус жив (мс). */
  expire_at_ms: number | null;
  /** Снимок панели после забора — клетки недельного круга. */
  panel: {
    days: SigninDay[];
  } | null;
};

/** Коды ответа вендора на неудачный забор. */
export type ClaimError = 'invalid_token' | 'http_error' | 'bad_response';

/** Итог забора: успех или честный отказ. */
export type ClaimOutcome =
  | { ok: true; data: ClaimResult }
  | { ok: false; error: ClaimError; message?: string };

/** Тело ответа вендора на забор. */
type ClaimPayload = {
  data?: {
    claim_result?: number;
    claim_id?: string | number;
    day_no?: number;
    points?: number;
    expire_at_ms?: number;
    panel?: { days?: SigninDay[] };
  };
  base_resp?: { status_code?: number; status_msg?: string };
};

const CLAIM_URL = 'https://agent.minimax.io/minimax-cloud/api/v1/signin/claim';

/**
 * Забрать суточный бонус аккаунта.
 *
 * ok: false — вендор не ответил или ответил ошибкой: это «не знаю», а не «очков нет»
 * (разница та же, что у панели: отказ по сети не должен выглядеть как пустой пул).
 */
export async function claimDailyBonus(
  accessToken: string,
  timezoneId: string,
  signal?: AbortSignal,
): Promise<ClaimOutcome> {
  const url = `${CLAIM_URL}?timezone_id=${encodeURIComponent(timezoneId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ timezone_id: timezoneId }),
      signal,
    });
  } catch {
    return { ok: false, error: 'http_error', message: 'вендор недоступен' };
  }

  let payload: ClaimPayload | null = null;
  try {
    payload = (await response.json()) as ClaimPayload;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const code = payload?.base_resp?.status_code;
    return {
      ok: false,
      error: code === 401 || code === 1004 ? 'invalid_token' : 'http_error',
      message: payload?.base_resp?.status_msg ?? `HTTP ${response.status}`,
    };
  }

  const data = payload?.data;
  if (!data || typeof data.claim_result !== 'number') {
    return { ok: false, error: 'bad_response', message: 'вендор ответил без claim_result' };
  }

  return {
    ok: true,
    data: {
      claim_result: data.claim_result,
      claim_id: data.claim_id === undefined || data.claim_id === null ? null : String(data.claim_id),
      day_no: typeof data.day_no === 'number' ? data.day_no : null,
      points: typeof data.points === 'number' ? data.points : null,
      expire_at_ms: typeof data.expire_at_ms === 'number' ? data.expire_at_ms : null,
      panel: Array.isArray(data.panel?.days)
        ? { days: data.panel!.days as SigninDay[] }
        : null,
    },
  };
}

/** Ответ вендора: `claim_result` = 1 (забрали) или 2 (уже было сегодня). */
export const CLAIM_RESULT_CLAIMED = 1;
export const CLAIM_RESULT_ALREADY = 2;
