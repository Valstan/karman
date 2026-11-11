/**
 * Недельная квота MiniMax: сколько активаций (чек-инов) у аккаунта осталось,
 * какая это по счёту клетка и сколько очков за неё положено.
 *
 * ## Что сказано в документации MiniMax (проверено 08.11)
 *
 * - **Очки даёт ежедневный чек-ин**: 400 за день, а в 4-й и 7-й дне — 1000;
 *   за полную неделю — 4000 очков («每日签到»: «Daily check-ins earn 400 points…
 *   day 4 and day 7 award 1,000… a full week of check-ins earns 4,000»).
 * - **Окна расхода**: 5-часовое (не-видео) и недельное (7 дней, все модели).
 *
 * ## ГЛАВНОЕ: номер клетки — это СЕРИЯ ДНЕЙ ПОДРЯД (разбор 09.11)
 *
 * Пропущенные сутки серию обрывают — проверено на боевом журнале 11.11: из 147
 * строк, где номер назвал сам владелец, «серия календарных дней подряд» совпала
 * в 145 (98,6 %), а конкурирующая модель «счётчик чек-инов без сброса» — только
 * в 57 из 223. Значит вопрос владельца «если сутки пропустить, всё начинается
 * сначала?» — да, начинается сначала.
 *
 * ## После седьмой клетки цикл начинается заново (решение владельца 11.11)
 *
 * Документация MiniMax описывает неделю чек-инов: семь дней подряд — 4000
 * очков (5×400 + 2×1000), дальше неделя начинается заново. Значит 8-й день
 * подряд — снова первая клетка (400 очков), а не «седьмая» (1000). До 11.11 код
 * потолковал клетку семью и обещал 1000 очков там, где MiniMax даёт 400.
 *
 * ## Клетка и очки решают, кого активировать (заказ владельца 11.11)
 *
 * Измерьщи 11.11: 85 аккаунтов, 51–66 активаций в сутки, и только **9 из 428**
 * активаций дали 1000 очков (2 %) — среднее 357 очков на активацию при
 * потолке 571 (= 4000 за семь дней подряд). Причина: аккаунтов больше, чем
 * активаций в сутки, поэтому 20–35 аккаунтов каждый день пропускаются, их
 * серия умирает, и очки падают до 400.
 *
 * Поэтому выбор аккаунта (см. `lib/accounts/rotation.ts`) идёт не по «давноте
 * использования», а по деньгам: сначала активация, которая даст 1000 (клетка 4
 * или 7), потом та, до бонуса которой ближе всего, потом длинная серия, и
 * только потом свежие аккаунты — новые в оборот берём по мере надобности.
 *
 * Разбор боевых данных 09.11 (85 аккаунтов, 306 активаций за 03–09.11) показал
 * настоящее правило MiniMax: **номер на панели — счётчик дней подряд**.
 *
 * - 08.11 (воскресенье) отработано 66 аккаунтов. 09.11 (понедельник) владелец
 *   нажал кнопку **1** ровно у 19 аккаунтов — это в точности те, которых НЕ
 *   было вчера (85 − 66 = 19), и кнопку **2** ровно у 20 — те, что были вчера.
 *   Перекрёстных случаев ноль.
 * - Значит: отмечен вчера → сегодня вторая клетка; пропущен вчера → серия
 *   сгорела, снова первая.
 * - Гипотеза «недельные лимиты сбрасываются ночью в понедельник» (заказ
 *   владельца 09.11) этим **опровергается**: в воскресенье на панели были
 *   кнопки 2, 3 и 4, а не седьмая — календарная неделя пн–вс дала бы всем одну
 *   и ту же клетку.
 *
 * Раньше номер считался как «строка журнала + 1», потом — как позиция дня в
 * неделе от первого использования. Оба варианта давали неверную подсказку:
 * 09.11 программа предлагала клетки 4, 5 и 7, а настоящая панель показывала
 * 1 и 2 — владельцу приходилось переопределять её почти каждый раз. Теперь
 * номер считается по датам: серия дней подряд.
 *
 * ## Недельная квота — календарная неделя (понедельник — воскресенье)
 *
 * Заказ владельца 09.11: «недельные лимиты сбрасываются ночью в понедельник,
 * каждая новая неделя начинается с чистого листа». Значит, недельная квота
 * считается по календарной неделе, а не по собственному циклу аккаунта:
 * отметки прошлой недели в счёт не идут, сброс — в ночь на понедельник.
 *
 * ## Номер, названный владельцем
 *
 * Кнопка «Записать N-й номер» остаётся: это запись в журнал (что владелец
 * видел на настоящей панели) и страховка, если программа ошибается. На
 * подсказку он больше не влияет — подсказку считает сама программа по датам.
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

/**
 * Клетка панели по длине серии дней подряд — **с перезапуском цикла на 8-й день**.
 *
 * Документация MiniMax описывает НЕДЕЛЮ чек-инов: «A full week of check-ins
 * earns 4,000 points» — семь дней подряд дают 5×400 + 2×1000 = 4000, и дальше
 * неделя начинается заново. Значит 8-й день подряд — это снова ПЕРВАЯ клетка
 * (400 очков), а не «седьмая с потолком» (1000).
 *
 * До 11.11 код потолковал клетку семью (`min(streak + 1, 7)`) — на 8-й день он
 * обещал 1000 очков там, где MiniMax даёт 400. Решение владельца 11.11: после
 * седьмого дня цикл начинается с первой клетки.
 *
 * `streak` — сколько дней подряд аккаунт уже отмечен (0 — вчера пропущено).
 */
export function cycleCell(streak: number): number {
  return (streak % WEEKLY_ACTIVATION_LIMIT) + 1;
}

/**
 * Сколько активаций подряд (включая ближайшую) до следующей бонусной клетки.
 *
 * Это расстояние решает, кого брать, когда очки у всех одинаковые: аккаунт,
 * которому до 1000 остался один день, дороже аккаунта, которому до 1000 четыре
 * дня — его нельзя пропустить, иначе бонус сгорает до следующей недели.
 */
export function daysToBonus(streak: number): number {
  for (let step = 0; step < WEEKLY_ACTIVATION_LIMIT; step += 1) {
    const cell = cycleCell(streak + step);
    if (pointsForIndex(cell) === 1000) return step + 1;
  }
  return WEEKLY_ACTIVATION_LIMIT;
}

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
   * Начало текущей серии дней подряд ('YYYY-MM-DD') или null — серия сгорела
   * (вчера отметки не было).
   */
  anchorDate: string | null;
  /** Длина текущей серии дней подряд (0 — вчера пропущено, серия сгорела). */
  streak: number;
  /**
   * Календарная неделя (понедельник — воскресенье), в которой живёт недельная
   * квота: лимиты обнуляются в ночь на понедельник.
   */
  cycle: WeeklyCycle;
  /** Сколько чек-инов уже было в текущей календарной неделе. */
  used: number;
  /** Сколько дней текущей календарной недели ещё можно отметить. */
  remaining: number;
  /**
   * Номер клетки, который получит СЛЕДУЮЩАЯ активация (1..7) или null —
   * отмечать больше нечего.
   *
   * Номер — это **серия дней подряд** (разбор 09.11 по боевым данным): вчера
   * отмечен — вторая клетка; вчера пропущено — серия сгорела, снова первая.
   */
  nextIndex: number | null;
  /**
   * Очки, которые даст СЕГОДНЯШНЯЯ активация.
   *
   * 0 — если чек-ин за сегодня уже был: очки начисляются раз в сутки, второй
   * раз в тот же день они не дают (заказ владельца 11.11: «в один день
   * несколько раз очки активировать — это не страшно», но очков это не даёт).
   * 1000 — если сегодняшняя клетка 4-я или 7-я.
   */
  pointsToday: number;
  /**
   * Сколько активаций подряд (включая ближайшую) до следующей бонусной клетки:
   * 1 — бонус сегодня, 4 — бонус через три дня. Расстояние решает, кого брать
   * при равных очках: аккаунт, которому до 1000 остался один день, пропускать
   * нельзя — бонус сгорает до следующей недели.
   */
  daysToBonus: number;
  /** Номер активации, названный владельцем (1..7) или null — не называл. */
  confirmedIndex: number | null;
  /** Нечего больше отметить в этой неделе. */
  exhausted: boolean;
  /** Очки, которые ещё можно получить в текущей неделе. */
  pointsLeft: number;
};

/**
 * Номер клетки для даты — позиция дня в цикле (по календарной неделе или по
 * серии дней подряд).
 */
export function cycleDayNumber(cycle: WeeklyCycle, date: string): number {
  return dayNumber(date) - dayNumber(cycle.startDate) + 1;
}

/**
 * Состояние недельной квоты аккаунта по его чек-инам.
 *
 * Два счёта, и они не одно и то же:
 *
 * - **Квота** (`used`/`remaining`/`exhausted`) — сколько дней текущей
 *   КАЛЕНДАРНОЙ недели (понедельник — воскресенье) аккаунт ещё может
 *   отметить: чек-ин в сутки один, неделя — 7 дней, то есть максимум семь
 *   активаций; когда отмечать больше нечего, аккаунт до следующей недели не
 *   предлагается (заказ владельца 07.11). Лимиты обнуляются в ночь на
 *   понедельник (заказ владельца 09.11), поэтому отметки прошлой недели в
 *   счёт не идут.
 * - **Номер активации** (`nextIndex`) — СЕРИЯ ДНЕЙ ПОДРЯД: сколько дней подряд
 *   аккаунт отмечался (разбор 09.11 по боевым данным). По нему идут очки:
 *   4-я и 7-я клетки — 1000.
 */
export function weeklyQuota(checkIns: WeeklyCheckIn[], todayDate: string): WeeklyQuota {
  const sorted = [...checkIns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const cycle = calendarWeek(todayDate);

  // Чек-ины текущей календарной недели: прошлая неделя в счёт не идёт — лимит
  // обнуляется в ночь на понедельник (09.11, заказ владельца).
  const weekRows = sorted.filter((row) => row.date >= cycle.startDate && row.date <= cycle.endDate);
  const used = weekRows.length;

  // Серия дней подряд: считаем назад от последней отметки. Вчера пропущено —
  // серия сгорела, и следующая отметка снова первая.
  const lastRow = sorted[sorted.length - 1] ?? null;
  const age = lastRow ? dayNumber(todayDate) - dayNumber(lastRow.date) : Number.POSITIVE_INFINITY;
  const streak = age <= 1 ? streakEndingAt(sorted, lastRow!.date) : 0;
  const anchorDate = streak > 0 ? shiftDate(lastRow!.date, -(streak - 1)) : null;

  // Отмечен ли аккаунт сегодня: чек-ин в сутки один, поэтому второй раз за
  // сутки очков не даёт (заказ владельца 11.11).
  const checkedInToday = lastRow?.date === todayDate;

  // Клетка следующей активации: серия продолжается, а после седьмой клетки
  // цикл ПЕРЕЗАПУСКАЕТСЯ с первой (решение владельца 11.11: неделя чек-инов
  // начинается заново — «a full week of check-ins earns 4,000 points»).
  const nextCell = cycleCell(streak);

  // Очки сегодняшней активации и расстояние до ближайшей бонусной клетки —
  // по ним выбирается, кого активировать (см. lib/accounts/rotation.ts).
  const pointsToday = checkedInToday ? 0 : pointsForIndex(nextCell);
  const bonusDistance = daysToBonus(streak);

  // Дни недели, которые ещё можно отметить (чек-ин в сутки один).
  const claimed = new Set(weekRows.map((row) => row.date));
  const available: string[] = [];
  for (let offset = 0; offset < WEEKLY_CYCLE_DAYS; offset += 1) {
    const date = shiftDate(cycle.startDate, offset);
    if (date < todayDate) continue;
    if (!claimed.has(date)) available.push(date);
  }
  const remaining = available.length;
  const exhausted = remaining === 0;

  // Очки за оставшиеся дни — проекция серии, если владелец не пропустит день.
  // Цикл перезапускается после седьмой клетки (решение владельца 11.11).
  let cell = nextCell;
  const pointsLeft = available.reduce((sum, _date) => {
    const value = pointsForIndex(cell);
    cell = cycleCell(cell);
    return sum + value;
  }, 0);

  return {
    anchorDate,
    streak,
    cycle,
    used,
    remaining,
    nextIndex: exhausted ? null : nextCell,
    pointsToday: exhausted ? 0 : pointsToday,
    daysToBonus: bonusDistance,
    confirmedIndex: lastRow ? ownerConfirmedIndex(sorted, lastRow) : null,
    exhausted,
    pointsLeft,
  };
}

/**
 * Календарная неделя (понедельник — воскресенье), в которой живёт недельная
 * квота: лимиты обнуляются в ночь на понедельник.
 */
export function calendarWeek(todayDate: string): WeeklyCycle {
  const startDate = moscowWeekStart(todayDate);
  return { startDate, endDate: shiftDate(startDate, WEEKLY_CYCLE_DAYS - 1) };
}

/** Очки за активацию по её номеру в неделе (1..7). */
export function pointsForIndex(index: number): number {
  const clamped = Math.min(Math.max(index, 1), WEEKLY_ACTIVATION_LIMIT);
  return WEEKLY_ACTIVATION_POINTS[clamped - 1]!;
}

/**
 * Длина серии дней подряд, заканчивающейся в `endDate`: считаем назад, пока
 * дни идут подряд.
 *
 * Пропущенный день обрывает серию — клетка панели гаснет, и нумерация
 * начинается заново (это и есть настоящая механика MiniMax, см. разбор
 * 09.11 по боевым данным).
 */
function streakEndingAt(sorted: WeeklyCheckIn[], endDate: string): number {
  const dates = new Set(sorted.map((row) => row.date));
  let length = 0;
  let cursor = endDate;
  while (dates.has(cursor)) {
    length += 1;
    cursor = shiftDate(cursor, -1);
  }
  return length;
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

/**
 * Здоровье когорты — стратегия владельца 11.11.
 *
 * Когорта — это аккаунты, которые активируются КАЖДЫЙ день: у них живая серия
 * дней подряд, и только она даёт бонусные клетки (4-ю и 7-ю, по 1000 очков).
 * Пропущенные сутки обнуляют серию, поэтому цену пропуска надо видеть каждый
 * день — иначе когорта незаметно рассыпается, а очки падают до 400.
 *
 * Числа считаются по журналу чек-инов и по окну простоя, ничего не зная о
 * MiniMax, кроме её же правил (см. docs/minimax.md).
 */
export type CohortStats = {
  /** Сколько аккаунтов имели живую серию вчера (отмечены вчера). */
  liveYesterday: number;
  /** Сколько из них продолжены сегодня. */
  continuedToday: number;
  /**
   * Сколько живых вчера ещё НЕ отмечены сегодня — их надо активировать до
   * конца дня, иначе серия сгорит.
   */
  atRisk: number;
  /** Сколько очков они дадут, если активировать сегодня. */
  pointsAtRisk: number;
  /** Сколько очков на них потеряется, если сегодня пропустить (то, что не 400). */
  pointsLostIfSkipped: number;
  /** Сколько доступных сегодня аккаунтов дадут 1000 очков (клетка 4 или 7). */
  bonusToday: number;
};

/**
 * Здоровье когорты по аккаунтам: сколько живых серий вчера, сколько продолжено
 * сегодня, сколько под риском и сколько это стоит.
 *
 * Считается по тому же журналу, что и недельная квота, поэтому числа в строке
 * статистики и в этом своде не могут разойтись.
 */
export function cohortStats(accounts: WeeklyAccountInput[], todayDate: string): CohortStats {
  let liveYesterday = 0;
  let continuedToday = 0;
  let atRisk = 0;
  let pointsAtRisk = 0;
  let bonusToday = 0;

  for (const account of accounts) {
    const { streak, nextIndex, pointsToday, exhausted } = account.quota;
    const aliveYesterday = account.checkedInToday ? streak >= 2 : streak >= 1;
    if (aliveYesterday) liveYesterday += 1;

    // Сегодня доступны тысячные — цель на день. Считаем и для тех, кто в зоне
    // риска: если активировать сегодня, бонус будет.
    if (!exhausted && pointsToday === 1000 && activatableToday(account, todayDate)) {
      bonusToday += 1;
    }

    if (account.checkedInToday && streak >= 2) {
      // Живая вчера и продолжена сегодня — серия цела.
      continuedToday += 1;
    } else if (!account.checkedInToday && streak >= 1) {
      // Живая вчера, но сегодня ещё не отмечен: серия держится на волоске —
      // если не активировать сегодня, она сгорит.
      atRisk += 1;
      if (nextIndex !== null) pointsAtRisk += pointsForIndex(nextIndex);
    }
  }

  return {
    liveYesterday,
    continuedToday,
    atRisk,
    pointsAtRisk,
    pointsLostIfSkipped: pointsAtRisk - 400 * atRisk,
    bonusToday,
  };
}

/** Сводка по недельному запасу — то, что стоит в строке статистики. */
export type WeeklyPoolStats = {
  /** Сколько активаций ещё можно сделать сегодня. */
  today: number;
  /** Сколько из них можно сделать прямо сейчас (окно уже истекло). */
  freeNow: number;
  /** Сколько освободятся в ближайшие 5 часов (сброс 5-часового окна MiniMax). */
  freesIn5h: number;
  /** Сколько активаций осталось в текущей календарной неделе. */
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
  /** Дата сброса недельных лимитов (понедельник следующей недели). */
  weekResetsOn: string;
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
/** Окно сброса лимитов MiniMax — 5 часов (собственное окно Кармана — 10 часов). */
const FIVE_HOURS_MS = 5 * 60 * 60_000;

export function weeklyPoolStats(
  accounts: WeeklyAccountInput[],
  usageByDay: WeeklyUsageDay[],
  todayDate: string,
  nowIso: string = new Date().toISOString(),
): WeeklyPoolStats {
  let today = 0;
  let freeNow = 0;
  let freesIn5h = 0;
  let week = 0;
  let weekPoints = 0;
  const nowMs = new Date(nowIso).getTime();
  for (const account of accounts) {
    if (account.quota.exhausted) continue;
    week += account.quota.remaining;
    weekPoints += account.quota.pointsLeft;
    if (!account.checkedInToday && activatableToday(account, todayDate)) {
      today += 1;
      if (!account.spent) {
        freeNow += 1;
      } else if (account.releasesAt !== null) {
        const inMs = new Date(account.releasesAt).getTime() - nowMs;
        if (inMs > 0 && inMs <= FIVE_HOURS_MS) freesIn5h += 1;
      }
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
    freeNow,
    freesIn5h,
    week,
    weekPoints,
    perDay,
    daysLeft,
    coversWeek: daysLeft === null ? null : daysLeft >= daysToWeekEnd,
    daysToWeekEnd,
    weekResetsOn: shiftDate(weekStart, WEEKLY_CYCLE_DAYS),
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
