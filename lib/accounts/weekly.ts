/**
 * Недельная квота MiniMax: сколько активаций (чек-инов) у аккаунта осталось
 * в текущей неделе, какая это по счёту клетка недели и сколько очков за неё
 * положено.
 *
 * ## Что сказано в документации MiniMax (проверено 08.11)
 *
 * - **Очки даёт ежедневный чек-ин**: 400 за день, а в 4-й и 7-й день недели —
 *   1000; за полную неделю — 4000 очков (документация M Plan, раздел
 *   «每日签到 / Daily Check-In»: «Daily check-ins earn 400 points, check-ins on
 *   day 4 and day 7 award 1,000 points, a full week of check-ins earns 4,000»).
 * - **Неделя — не общий календарь, а 7 дней от ПЕРВОГО использования аккаунта**
 *   (раздел «用量说明 / Usage»: «两个窗口都从首次使用时开始计时…周窗口持续 7
 *   days» — и 5-часовое, и недельное окно начинаются с первого использования).
 *
 * Второй пункт — прямой ответ на вопрос владельца (07.11): «когда сбрасывается
 * недельный лимит — в какую-то дату у всех одинаково или это зависит от даты
 * активации аккаунта». Ответ: **зависит от аккаунта**. У каждого аккаунта своя
 * неделя, и начинается она с его первой активации.
 *
 * ## ГЛАВНОЕ: номер активации — это КАЛЕНДАРНАЯ КЛЕТКА НЕДЕЛИ, а не число строк
 *
 * Недельная панель чекина MiniMax — календарь: у аккаунта есть неделя (7 дней
 * от его первого использования), и в ней у каждого дня своя клетка со своим
 * номером (1..7) и своим количеством очков (400/400/400/1000/400/400/1000).
 * Пропущенный день не сдвигает нумерацию — его клетка просто сгорает, а
 * номера следующих дней не меняются.
 *
 * Раньше (заказ 07.11) номер считался как ЧИСЛО СТРОК журнала в неделе плюс
 * один. Это работало ровно до первого пропущенного дня — и дальше ломалось:
 * дней отработано меньше, чем прошло, значит номер меньше, и программа уезжала
 * на клетку «4-я» (1000 очков) и держалась на ней. Именно это владелец и видел:
 * «программа всё время показывает 1000 очков» (08.11). На боевых данных 08.11
 * почти все аккаунты показывали именно 1000 — потому что у них было по три
 * строки, а «три строки + один» и есть клетка 4.
 *
 * Теперь номер = позиция КАЛЕНДАРНОГО дня в неделе аккаунта.
 *
 * ## Уточнение владельца — и почему оно нужно
 *
 * Наша неделя считается по ЖУРНАЛУ, а журнал начат только 04.11. Аккаунты,
 * которыми владелец пользовался раньше, имеют настоящую неделю, начавшуюся
 * ДО журнала, — и наша нумерация для них сдвинута. Владелец видит настоящий
 * номер на панели MiniMax и может назвать его руками (заказ 07.11: «если не
 * получается — спроси при активации, какая это по счёту активация»; заказ
 * 08.11: семь кнопок выбора номера прямо в окне активации).
 *
 * Названный номер не просто записывается в строку журнала — он **выправляет**
 * начало нашей недели: дальше программа считает от его номера. Одно уточнение —
 * и счёт снова верный.
 *
 * ## Старые авто-значения в журнале — им не доверяем
 *
 * Номера, которые записала сломанная формула («номер строки в недельном цикле»),
 * лежат в журнале с 07.11 и в счёт не идут: именно они уводили программу на
 * клетку «4-я». Такие значения опознаются на лету (`legacyDerivedIndex`) — по
 *этому миграция и правка боевой базы не нужны.
 *
 * Модуль чистый (без БД и без server-only) — юнит-тестируется.
 */

import { shiftDate } from './stats';

/** Сколько активаций (чек-инов) аккаунт может сделать за одну неделю. */
export const WEEKLY_ACTIVATION_LIMIT = 7;

/** Длина недельного окна в днях. */
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
  /** Номер активации в неделе (1..7) или null — номер неизвестен. */
  index: number | null;
};

/** Недельное окно аккаунта: семь дней от первого использования. */
export type WeeklyCycle = {
  /** Первый день окна (первое использование аккаунта в этой неделе). */
  startDate: string;
  /** Последний день окна (startDate + 6). */
  endDate: string;
};

/** Состояние недельной квоты аккаунта. */
export type WeeklyQuota = {
  /**
   * Начало текущей недели аккаунта ('YYYY-MM-DD') или null — аккаунт ещё ни
   * разу не активировался (тогда его неделя начнётся в день первого
   * использования).
   */
  anchorDate: string | null;
  /** Текущее недельное окно. */
  cycle: WeeklyCycle;
  /** Сколько чек-инов уже было в текущем окне. */
  used: number;
  /** Сколько дней текущего окна ещё можно отметить. */
  remaining: number;
  /**
   * Номер клетки, который получит СЛЕДУЮЩАЯ активация (1..7) или null —
   * отмечать больше нечего.
   *
   * По умолчанию — календарная позиция дня в неделе аккаунта. Если владелец
   * уточнял номер руками, программа считает дальше ОТ ЕГО номера.
   */
  nextIndex: number | null;
  /** Номер активации, названный владельцем (1..7) или null — не называл. */
  confirmedIndex: number | null;
  /** Нечего больше отметить в этом окне (все дни заняты или окно кончилось). */
  exhausted: boolean;
  /** Очки, которые ещё можно получить в текущем окне. */
  pointsLeft: number;
};

/**
 * Недельное окно аккаунта, начавшееся в `anchorDate`: семь московских дней.
 *
 * Неделя у аккаунта своя — это 7 дней ОТ ПЕРВОГО использования (документация
 * MiniMax), поэтому окно всегда одно и то же семь дней: `startDate` и
 * `startDate + 6`.
 */
export function weeklyCycle(anchorDate: string): WeeklyCycle {
  return {
    startDate: anchorDate,
    endDate: shiftDate(anchorDate, WEEKLY_CYCLE_DAYS - 1),
  };
}

/**
 * Номер клетки для даты — календарная позиция в неделе аккаунта.
 *
 * Клетки нумеруются по календарю: 1,2,…,7. Пропущенный день не сдвигает
 * нумерацию — его клетка просто сгорает.
 */
export function cycleDayNumber(cycle: WeeklyCycle, date: string): number {
  return dayNumber(date) - dayNumber(cycle.startDate) + 1;
}

/**
 * Состояние недельной квоты аккаунта по его чек-инам.
 *
 * Два счёта, и они не одно и то же:
 *
 * - **Квота** (`used`/`remaining`/`exhausted`) — сколько дней недели аккаунт
 *   ещё может отметить: чек-ин в сутки один, неделя — 7 дней, то есть
 *   максимум семь активаций; когда отмечать больше нечего, аккаунт до
 *   следующей недели не предлагается (заказ владельца 07.11).
 * - **Номер активации** (`nextIndex`) — календарная позиция дня в неделе
 *   аккаунта. По нему идут очки: 4-я и 7-я клетки — 1000.
 *
 * Неделя аккаунта — 7 дней от первого использования: следующее использование
 * после конца окна открывает НОВОЕ окно (и счёт начинается с клетки 1).
 *
 * Уточнение владельца (он смотрит настоящую панель MiniMax) выправляет начало
 * недели: дальше программа считает от его номера.
 */
export function weeklyQuota(checkIns: WeeklyCheckIn[], todayDate: string): WeeklyQuota {
  const sorted = [...checkIns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Никогда не активировавшийся аккаунт: его неделя начнётся в день первого
  // использования, то есть сегодня.
  if (sorted.length === 0) {
    return {
      anchorDate: null,
      cycle: weeklyCycle(todayDate),
      used: 0,
      remaining: WEEKLY_ACTIVATION_LIMIT,
      nextIndex: 1,
      confirmedIndex: null,
      exhausted: false,
      pointsLeft: WEEKLY_POINTS_TOTAL,
    };
  }

  // 1. Текущее окно по журналу: неделя длится 7 дней от первого использования,
  //    а использование после конца окна открывает новое окно.
  const windowRows = currentWindowRows(sorted);
  const journalAnchor = windowRows[0]!.date;

  // 2. Уточнение владельца: номер, названный им САМИМ (а не посчитанный
  //    старой сломанной формулой). Оно выправляет начало недели.
  const lastRow = windowRows[windowRows.length - 1]!;
  const confirmedIndex = ownerConfirmedIndex(sorted, lastRow);
  const anchorDate =
    confirmedIndex === null ? journalAnchor : shiftDate(lastRow.date, -(confirmedIndex - 1));

  // 3. Окно кончилось (сегодня уже за его пределами) → ближайшее использование
  //    открывает новое окно, и счёт начинается с клетки 1.
  let anchor = anchorDate;
  let rows = windowRows.filter((row) => row.date >= anchor);
  if (todayDate > shiftDate(anchor, WEEKLY_CYCLE_DAYS - 1)) {
    anchor = todayDate;
    rows = sorted.filter((row) => row.date >= anchor);
  }

  const cycle = weeklyCycle(anchor);
  const claimed = new Set(rows.map((row) => row.date));

  // Отметить можно каждый день окна, который ещё не прошёл и ещё не отмечен;
  // день, прошедший без отметки, безвозвратно пропал (клетка панели сгорела).
  const available: string[] = [];
  for (let offset = 0; offset < WEEKLY_CYCLE_DAYS; offset += 1) {
    const date = shiftDate(cycle.startDate, offset);
    if (date < todayDate) continue;
    if (!claimed.has(date)) available.push(date);
  }

  const used = rows.length;
  const remaining = available.length;
  const exhausted = remaining === 0;
  const nextIndex = exhausted ? null : cycleDayNumber(cycle, available[0]!);
  const pointsLeft = available.reduce(
    (sum, date) => sum + pointsForIndex(cycleDayNumber(cycle, date)),
    0,
  );

  return {
    anchorDate,
    cycle,
    used,
    remaining,
    nextIndex,
    confirmedIndex,
    exhausted,
    pointsLeft,
  };
}

/** Очки за активацию по её номеру в неделе (1..7). */
export function pointsForIndex(index: number): number {
  const clamped = Math.min(Math.max(index, 1), WEEKLY_ACTIVATION_LIMIT);
  return WEEKLY_ACTIVATION_POINTS[clamped - 1]!;
}

/**
 * Строки журнала текущего недельного окна аккаунта.
 *
 * Окно — 7 дней от первого использования. Использование позже конца окна
 * открывает новое окно, и в текущее попадают только строки последнего.
 */
function currentWindowRows(sorted: WeeklyCheckIn[]): WeeklyCheckIn[] {
  const rows: WeeklyCheckIn[] = [];
  let anchor = sorted[0]!.date;
  for (const row of sorted) {
    if (rows.length > 0 && dayNumber(row.date) - dayNumber(anchor) >= WEEKLY_CYCLE_DAYS) {
      // Окно кончилось — следующее использование открывает новое.
      rows.length = 0;
      anchor = row.date;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Номер активации, названный владельцем, или null.
 *
 * В журнале лежат номера двух сортов:
 *
 * - названные владельцем (он смотрел настоящую панель MiniMax) — им верим;
 * - посчитанные СТАРОЙ сломанной формулой («номер строки в недельном цикле») —
 *   им не верим: именно они уводили программу на клетку «4-я» (1000 очков).
 *
 * Отличаются они без всякой миграции: старая формула — это позиция строки в
 * семидневном цикле журнала, и её значение можно воспроизвести по журналу
 * (`legacyDerivedIndex`). На боевых данных 08.11 так отличаются все старые
 * значения (сверка: 41 строка, совпадение 41).
 */
function ownerConfirmedIndex(sorted: WeeklyCheckIn[], row: WeeklyCheckIn): number | null {
  const index = row.index;
  if (index === null || index < 1 || index > WEEKLY_ACTIVATION_LIMIT) return null;
  if (index === legacyDerivedIndex(sorted, row)) return null;
  return index;
}

/**
 * Номер, который записала бы старая сломанная формула: позиция строки в
 * семидневном цикле журнала (от первого чек-ина аккаунта).
 *
 * Нужна, чтобы отличать авто-значение старой версии от номера, названного
 * владельцем: с 07.11 в журнале лежат и те, и другие, а по дате их не
 * различить.
 */
function legacyDerivedIndex(sorted: WeeklyCheckIn[], row: WeeklyCheckIn): number | null {
  const firstUse = sorted[0]!.date;
  const cycleIndex = Math.floor(
    (dayNumber(row.date) - dayNumber(firstUse)) / WEEKLY_CYCLE_DAYS,
  );
  const cycleStart = shiftDate(firstUse, cycleIndex * WEEKLY_CYCLE_DAYS);
  const cycleEnd = shiftDate(cycleStart, WEEKLY_CYCLE_DAYS - 1);
  const position = sorted.filter(
    (item) => item.date >= cycleStart && item.date <= cycleEnd && item.date <= row.date,
  ).length;
  return position;
}

/** Календарный номер даты — число суток от эпохи (московские даты без времени). */
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
 * Сводка по недельному запасу (заказ 07.11): сколько активаций
 * возможно сегодня, сколько осталось в неделях и сколько это очков, плюс
 * прогноз по текущему темпу — хватит ли до конца недели.
 *
 * Определения (чтобы числа на экране и в голове совпадали):
 *
 * - **«За день»** — активации, которые ещё можно сделать сегодня: аккаунты,
 *   которые свободны сейчас ИЛИ освобождаются сегодня, у которых не выбрана
 *   неделя (не 7 из 7) и которые сегодня ещё не чекинились (чек-ин в сутки
 *   один, повторный чек-ин очков не даёт).
 * - **«За неделю»** — сумма остатков недельных квот всех аккаунтов: у каждого
 *   сколько дней недели ещё можно отметить. Это сколько активаций ещё есть,
 *   прежде чем у каждого аккаунта своя неделя кончится.
 * - **«Очки»** — сумма очков за эти оставшиеся активации (400/1000 по
 *   номеру клетки).
 * - **«Темп»** — активаций в день за текущую московскую неделю (понедельник —
 *   воскресенье), усреднённо по прошедшим дням.
 * - **«≈ дней»** — на сколько дней хватит остатка при этом темпе.
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
    daysLeft: daysLeft === null ? null : daysLeft,
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
