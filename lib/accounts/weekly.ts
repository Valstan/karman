/**
 * Недельная квота MiniMax: сколько активаций (чек-инов) у аккаунта осталось
 * на этой неделе и сколько очков за них положено.
 *
 * ## Что сказано в документации MiniMax (проверено 07.11)
 *
 * - **Очки даёт ежедневный чек-ин**: 400 за день, а в 4-й и 7-й день подряд —
 *   1000; за полную неделю — 4000 очков (документация M Plan, раздел
 *   «每日签到 / Daily Check-In»: «Daily check-ins earn 400 points, check-ins on
 *   day 4 and day 7 award 1,000 points, a full week of check-ins earns 4,000»).
 * - **Неделя — не общий календарь, а 7 дней от ПЕРВОГО использования аккаунта**
 *   (раздел «用量说明 / Usage»: «两个窗口都从首次使用时开始计时…周窗口持续 7
 *   days» — и 5-часовой, и недельный окно начинаются с первого использования).
 *
 * Второй пункт — прямой ответ на вопрос владельца (07.11): «когда сбрасывается
 * недельный лимит — в какую-то дату у всех одинаково или это зависит от даты
 * активации аккаунта». Ответ: **зависит от аккаунта**. У каждого аккаунта своя
 * неделя, и начинается она с его первой активации.
 *
 * ## Модель, которую это даёт
 *
 * - у аккаунта есть недельный цикл из 7 московских дней; начало цикла — дата
 *   его ПЕРВОГО чек-ина;
 * - внутри цикла — до 7 активаций (чек-ин раз в сутки);
 * - очки за активацию задаются её номером в цикле: 4-я и 7-я — 1000,
 *   остальные — 400;
 * - когда все семь использованы, аккаунт до следующего цикла не предлагается
 *   (заказ владельца 07.11: «если на этой неделе у аккаунта уже прошло семь
 *   активаций, то ты не предлагай его для активации»).
 *
 * ## Откуда берётся «номер активации»
 *
 * Номер считается по журналу: сколько чек-инов у аккаунта уже было в текущем
 * цикле, плюс один. Но журнал до 07.11 не помнил номера активаций (появились
 * вместе с этой моделью), поэтому у старых строк номера нет — и тогда счёт
 * идёт по числу строк журнала. Владелец может уточнить номер руками при
 * активации (заказ 07.11: «если не получается — спроси при активации, какая
 * это по счёту активация»), и тогда номер записывается в журнал — и дальше
 * считается по нему, а не по числу строк.
 *
 * Модуль чистый (без БД и без server-only) — юнит-тестируется.
 */

import { shiftDate } from './stats';

/** Сколько активаций (чек-инов) аккаунт может сделать за одну неделю. */
export const WEEKLY_ACTIVATION_LIMIT = 7;

/** Длина недельного цикла в днях. */
export const WEEKLY_CYCLE_DAYS = 7;

/**
 * Очки за активацию по её номеру в неделе (1..7): 4-я и 7-я — 1000, остальные
 * — 400. Ровно та последовательность, что в документации MiniMax (400 в обычный
 * день, 1000 в 4-й и 7-й), и она даёт 4000 за полную неделю.
 */
export const WEEKLY_ACTIVATION_POINTS = [400, 400, 400, 1000, 400, 400, 1000] as const;

/** Очки за полную неделю — 4000 (сходится с документацией). */
export const WEEKLY_POINTS_TOTAL = 4000;

/** Один чек-ин аккаунта: дата (московская) и номер активации, если он известен. */
export type WeeklyCheckIn = {
  /** Московская дата чек-ина ('YYYY-MM-DD'). */
  date: string;
  /** Номер активации в неделе (1..7) или null — номер не зафиксирован. */
  index: number | null;
};

/** Недельный цикл аккаунта. */
export type WeeklyCycle = {
  /** Дата первого чек-ина — точка отсчёта недель аккаунта. */
  anchorDate: string;
  /** Номер текущего цикла (0 — первый). */
  cycleIndex: number;
  /** Первая дата текущего цикла. */
  startDate: string;
  /** Последняя дата текущего цикла (startDate + 6 дней). */
  endDate: string;
};

/** Состояние недельной квоты аккаунта. */
export type WeeklyQuota = {
  /** Точка отсчёта (дата первого чек-ина) или null — аккаунт ещё не активировался. */
  anchorDate: string | null;
  /** Текущий цикл. Для никогда не активировавшегося — цикл, начинающийся сегодня. */
  cycle: WeeklyCycle;
  /** Сколько чек-инов уже было в текущем цикле (это и есть израсходованная квота). */
  used: number;
  /** Сколько активаций можно сделать ещё (0..7). */
  remaining: number;
  /**
   * Номер следующей активации по умолчанию (1..7) или null — неделя исчерпана.
   *
   * Обычно это `used + 1`. Но если владелец уточнял номер руками (пропущенный
   * день сбивает счёт), то продолжаем от его номера: `подтверждённый + 1`.
   */
  nextIndex: number | null;
  /** Последний подтверждённый владельцем номер активации в цикле или null. */
  confirmedIndex: number | null;
  /** Исчерпан ли аккаунт на эту неделю (7 чек-инов из 7). */
  exhausted: boolean;
  /** Очки, которые ещё можно получить в текущем цикле. */
  pointsLeft: number;
};

/**
 * Цикл аккаунта на дату `todayDate`.
 *
 * Циклы идут от точки отсчёта (первый чек-ин) кусками по 7 дней: 0-й — дни
 * 0..6 от точки отсчёта, 1-й — дни 7..13, и так далее. Даты московские: неделя
 * владельца — календарная, а не инстанты.
 */
export function weeklyCycle(anchorDate: string, todayDate: string): WeeklyCycle {
  const anchor = dayNumber(anchorDate);
  const today = dayNumber(todayDate);
  const cycleIndex = Math.max(0, Math.floor((today - anchor) / WEEKLY_CYCLE_DAYS));
  return {
    anchorDate,
    cycleIndex,
    startDate: shiftDate(anchorDate, cycleIndex * WEEKLY_CYCLE_DAYS),
    endDate: shiftDate(anchorDate, cycleIndex * WEEKLY_CYCLE_DAYS + WEEKLY_CYCLE_DAYS - 1),
  };
}

/**
 * Состояние недельной квоты аккаунта по его чек-инам.
 *
 * Два счёта, и они не одно и то же:
 *
 * - **Квота** (`used`) — сколько чек-инов (активаций) уже было в цикле: это
 *   число строк журнала в цикле. Чек-ин в сутки один, неделя аккаунта — 7
 *   дней, то есть максимум семь; когда семь, аккаунт до следующего цикла не
 *   предлагается (заказ владельца 07.11).
 * - **Номер активации** (`nextIndex`) — счётчик «день подряд» у MiniMax: по
 *   умолчанию это `used + 1`. Но если владелец уточнял номер руками
 *   (пропущенный день сбивает счётчик «подряд»), продолжаем от его номера.
 */
export function weeklyQuota(checkIns: WeeklyCheckIn[], todayDate: string): WeeklyQuota {
  const sorted = [...checkIns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const anchorDate = sorted[0]?.date ?? null;

  // Никогда не активировавшийшийся аккаунт: его неделя начинается сегодня.
  if (anchorDate === null) {
    const cycle: WeeklyCycle = {
      anchorDate: todayDate,
      cycleIndex: 0,
      startDate: todayDate,
      endDate: shiftDate(todayDate, WEEKLY_CYCLE_DAYS - 1),
    };
    return {
      anchorDate: null,
      cycle,
      used: 0,
      remaining: WEEKLY_ACTIVATION_LIMIT,
      nextIndex: 1,
      confirmedIndex: null,
      exhausted: false,
      pointsLeft: WEEKLY_POINTS_TOTAL,
    };
  }

  const cycle = weeklyCycle(anchorDate, todayDate);
  const inCycle = sorted.filter((c) => c.date >= cycle.startDate && c.date <= cycle.endDate);
  // Квота — это СКОЛЬКО чек-инов было: чек-ин в сутки один, неделя — 7 дней,
  // то есть максимум семь. Когда семь — аккаунт до следующего цикла не
  // предлагается (заказ владельца 07.11).
  const used = inCycle.length;
  const remaining = Math.max(0, WEEKLY_ACTIVATION_LIMIT - used);
  const exhausted = remaining === 0;

  // А номер активации — счётчик «день подряд» у MiniMax. Если владелец
  // уточнял его руками (пропущенный день сбивает этот счётчик), продолжаем
  // от его номера, а не от числа строк.
  const confirmed = inCycle
    .filter((c) => c.index !== null && c.index >= 1 && c.index <= WEEKLY_ACTIVATION_LIMIT)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .pop()?.index ?? null;
  const nextIndex = exhausted
    ? null
    : Math.min(WEEKLY_ACTIVATION_LIMIT, (confirmed ?? used) + 1);

  return {
    anchorDate,
    cycle,
    used,
    remaining,
    nextIndex,
    confirmedIndex: confirmed,
    exhausted,
    pointsLeft: remainingPoints(used),
  };
}

/** Очки за активацию по её номеру в неделе (1..7). */
export function pointsForIndex(index: number): number {
  const clamped = Math.min(Math.max(index, 1), WEEKLY_ACTIVATION_LIMIT);
  return WEEKLY_ACTIVATION_POINTS[clamped - 1]!;
}

/**
 * Сколько очков ещё можно получить в цикле, где уже сделано `used`
 * активаций: сумма очков за оставшиеся номера (например, после трёх — 3200).
 */
export function remainingPoints(used: number): number {
  let sum = 0;
  for (let index = used + 1; index <= WEEKLY_ACTIVATION_LIMIT; index += 1) {
    sum += pointsForIndex(index);
  }
  return sum;
}

/** Календарный сдвиг даты на N суток — обёртка над `shiftDate`. */
function dayNumber(date: string): number {
  const parts = date.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error(`Некорректная московская дата: ${date}`);
  }
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

// --- Сводка по запасу (заказ владельца 07.11) ---------------------------------

/** Аккаунт во входе сводки: занятость окна + недельная квота. */
export type WeeklyAccountInput = {
  id: number;
  /** Занят ли аккаунт (окно простоя не истекло). */
  spent: boolean;
  /** Когда освободится (ISO) или null — уже свободен. */
  releasesAt: string | null;
  /** Был ли сегодня (по Москве) чек-ин у этого аккаунта. */
  checkedInToday: boolean;
  /** Недельная квота аккаунта. */
  quota: WeeklyQuota;
};

/** Сколько активаций было в каждый московский день. */
export type WeeklyUsageDay = {
  usedOn: string;
  activations: number;
};

/** Сводка по недельному запасу — то, что стоит в строке статистики. */
export type WeeklyPoolStats = {
  /** Сколько активаций ещё можно сделать сегодня. */
  today: number;
  /** Сколько активаций осталось в недельных циклах всех аккаунтов. */
  week: number;
  /** Очки за эти активации. */
  weekPoints: number;
  /** Темп: активаций в день за текущую московскую неделю. */
  perDay: number;
  /** На сколько дней хватит остатка при таком темпе (null — темп неизвестен). */
  daysLeft: number | null;
  /** Хватит ли остатка до конца московской недели (null — темп неизвестен). */
  coversWeek: boolean | null;
  /** Сколько дней осталось в текущей московской неделе, включая сегодня. */
  daysToWeekEnd: number;
};

/**
 * Сводка по недельному запасу (заказ владельца 07.11): сколько активаций
 * возможно сегодня, сколько осталось в неделях и сколько это очков, плюс
 * прогноз по текущему темпу — хватит ли до конца недели.
 *
 * Определения (чтобы числа на экране и в голове совпадали):
 *
 * - **«За день»** — активации, которые ещё можно сделать сегодня: аккаунты,
 *   которые свободны сейчас ИЛИ освобождаются сегодня, у которых не выбрана
 *   неделя (не 7 из 7) и которые сегодня ещё не чекинились (чек-ин в сутки
 *   один, повторный очков не даёт).
 * - **«За неделю»** — сумма остатков недельных квот всех аккаунтов: у каждого
 *   `7 − сделано в его текущем цикле`. Это сколько активаций ещё есть, прежде
 *   чем у каждого аккаунта своя неделя кончится.
 * - **«Очки»** — сумма очков за эти оставшиеся активации (400/1000 по
 *   номеру активации).
 * - **«Темп»** — активаций в день за текущую московскую неделю (понедельник —
 *   воскресенье), усреднённо по прошедшим дням недели.
 * - **«≈ дней»** — на сколько дней хватит остатка при таком темпе.
 */
export function weeklyPoolStats(
  accounts: WeeklyAccountInput[],
  usageByDay: WeeklyUsageDay[],
  todayDate: string,
): WeeklyPoolStats {
  let today = 0;
  let week = 0;
  let weekPoints = 0;
  for (const account of accounts) {
    if (!account.quota.exhausted) {
      week += account.quota.remaining;
      weekPoints += account.quota.pointsLeft;
      if (!account.checkedInToday && activatableToday(account, todayDate)) today += 1;
    }
  }

  const weekStart = moscowWeekStart(todayDate);
  const daysElapsed = dayNumber(todayDate) - dayNumber(weekStart) + 1;
  const daysToWeekEnd = WEEKLY_CYCLE_DAYS - daysElapsed + 1;
  const activationsThisWeek = usageByDay
    .filter((day) => day.usedOn >= weekStart && day.usedOn <= todayDate)
    .reduce((sum, day) => sum + day.activations, 0);
  const perDay = daysElapsed > 0 ? activationsThisWeek / daysElapsed : 0;

  const daysLeft = perDay > 0 ? week / perDay : null;
  return {
    today,
    week,
    weekPoints,
    perDay,
    daysLeft,
    coversWeek: daysLeft === null ? null : daysLeft >= daysToWeekEnd,
    daysToWeekEnd,
  };
}

/**
 * Можно ли активировать аккаунт сегодня: он либо уже свободен, либо
 * освобождается сегодня (московская дата освобождения — сегодняшняя).
 */
function activatableToday(account: WeeklyAccountInput, todayDate: string): boolean {
  if (!account.spent) return true;
  if (account.releasesAt === null) return true;
  return moscowDateOf(account.releasesAt) === todayDate;
}

/** Московская дата момента (ISO) — 'YYYY-MM-DD'. */
export function moscowDateOf(iso: string): string {
  return new Date(new Date(iso).getTime() + MOSCOW_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/** Понедельник текущей московской недели. */
export function moscowWeekStart(todayDate: string): string {
  const dow = new Date(dayNumber(todayDate) * 86_400_000).getUTCDay(); // 0 — воскресенье
  const offsetToMonday = (dow + 6) % 7;
  return shiftDate(todayDate, -offsetToMonday);
}

const MOSCOW_OFFSET_MINUTES = 180;

