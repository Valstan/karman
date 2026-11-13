/**
 * Раздача пула MiniMax проектам по HTTP — ЧИСТАЯ часть (без БД и без server-only).
 *
 * Заказ владельца (13.11): «Сарафан будет обращаться с запросом в получение нового
 * аккаунта минимакса для активации на своей стороне. Ты ему как у тебя заложено в
 * логике будешь отдавать самый подходящий аккаунт, ну подсказывать сколько там очков
 * должно быть активировано в этот раз, и все, дальше сарафан уже сам будет его
 * активировать и применять у себя на проде».
 *
 * ## Почему это не «второй подбор» и не «вторая математика»
 *
 * Подбор аккаунта и правило клетки живут в `lib/accounts/rotation.ts` и
 * `lib/accounts/weekly.ts`. Здесь они НЕ переписываются — здесь только:
 *
 * - выбирается ВЕРХНИЙ слот того же списка, что и в интерфейсе владельца
 *   (`splitAccounts` → `next`), то есть «самый подходящий» означает ровно то, что
 *   владелец видит наверху своего списка;
 * - считается, сколько очков даст активация (`pointsForIndex` от клетки) и какая
 *   клетка ожидается (`quota.nextIndex`);
 * - решается, что записать в журнал, когда проект прислал свой номер клетки или
 *   фактические очки.
 *
 * Правило клетки при этом НЕ трогается: чужое показание (номер с панели MiniMax)
 * попадает в журнал как «названное проектом» — ровно тем же полем, куда владелец
 * кладёт номер, который увидел своими глазами. Модель (номер по датам) от этого не
 * меняется, а расхождение видно — и это второй, независимый источник по вопросу о
 * клетке после пропущенного дня (аккаунт 3@).
 *
 * Модуль чистый — юнит-тестируется без БД.
 */

import {
  accountPoolSummary,
  isUnavailable,
  sortAccounts,
  type AccountRotationRow,
} from './rotation';
import { pointsForIndex, type WeeklyQuota } from './weekly';

/** Что именно отдаём проекту. Ровно то, что нужно для активации. */
export type PoolHandout = {
  /** id аккаунта в базе владельца. */
  id: number;
  /** Своя метка владельца («Матрица РМЗ — 12»). */
  title: string;
  /** Почта аккаунта — ею проект входит в MiniMax. */
  email: string;
  /** Пароль аккаунта — им проект входит. */
  password: string;
  /** Клетка, которую мы ждём от этого аккаунта (1..7) или null (неделя исчерпана). */
  activation_index: number | null;
  /** Сколько очков даст активация: 1000 (клетка 4 или 7), 400 — обычный день, 0 — чек-ин за сегодня уже был. */
  points_next: number;
  /** Текущая серия дней подряд. */
  streak: number;
  /** Через сколько дней будет бонусная клетка (1000 очков). */
  next_bonus_in_days: number;
  /** Москва-дата последней активации или null — аккаунт не активировался. */
  used_on: string | null;
  /** Исчерпана ли неделя аккаунта (7 из 7) — тогда его не предлагают. */
  quota_exhausted: boolean;
};

/** Ответ на «дай аккаунт»: аккаунт (или честная пустота) + состояние пула. */
export type PoolOffer = {
  /** Аккаунт к активации или null — сегодня брать нечего. */
  account: PoolHandout | null;
  /** Почему аккаунта нет (когда account === null). */
  reason: 'no_free_accounts' | null;
  /** Откуда взят аккаунт: 400 очков (обычный случай), 1000 (крайний случай) или 0 (уже отмечен сегодня). */
  tier: PoolTier | null;
  /** Сколько аккаунтов свободно прямо сейчас (включая предложенный). */
  free: number;
  /** Сколько освободится в ближайшие полчаса. */
  soon: number;
  /** Кто получил (имя комнаты проекта). */
  project: string;
  /** Сегодняшняя московская дата — по ней «день активации». */
  today: string;
};

/**
 * Какой очковый класс отдан проекту.
 *
 * Правило владельца (13.11): **Сарафану — аккаунты, с которых сегодня можно взять
 * 400 очков; аккаунты на 1000 очков владелец оставляет себе** (комп, программирование)
 * и отдаёт проекту только в крайнем случае — когда свободных четырёхсотых не
 * осталось, а тысячные ещё есть.
 *
 * Третий класс — аккаунты, уже отмеченные сегодня (очки 0): они не стоят владельцу
 * ничего, но и проекту очков не дают, поэтому идут последними.
 */
export type PoolTier = 'points_400' | 'points_1000' | 'points_0';

/**
 * Верхний слот пула — тот же, что показывается владельцу наверху списка, но с
 * фильтром по очкам (правило владельца 13.11): проекту отдаётся аккаунт на **400**
 * очков; аккаунт на **1000** — только если свободных четырёхсотых не осталось;
 * уже отмеченные сегодня (0 очков) — последним резервом.
 *
 * Правило выбора внутри класса — прежнее, из `rotation.ts`: сначала активация, которая
 * даст 1000 (клетка 4 или 7), потом та, до бонуса которой ближе всего, потом длинная
 * серия, потом давность. Занятые окном (5 ч) и аккаунты с исчерпанной неделей в выдачу
 * не попадают.
 */
export function pickPoolAccount<T extends AccountRotationRow>(
  accounts: T[],
  now: Date = new Date(),
): { account: T | null; free: number; soon: number; tier: PoolTier | null } {
  const summary = accountPoolSummary(accounts, now);
  const sorted = sortAccounts(accounts, now);
  const free = sorted.filter((account) => !isUnavailable(account, now));

  const pick = (points: number): T | null =>
    free.find((account) => account.weekPointsNext === points) ?? null;

  const four = pick(400);
  if (four) return { account: four, free: summary.free, soon: summary.soon, tier: 'points_400' };
  const thousand = pick(1000);
  if (thousand) {
    return { account: thousand, free: summary.free, soon: summary.soon, tier: 'points_1000' };
  }
  const zero = pick(0);
  if (zero) return { account: zero, free: summary.free, soon: summary.soon, tier: 'points_0' };
  return { account: null, free: summary.free, soon: summary.soon, tier: null };
}

/** Сборка ответа: аккаунт + состояние пула. Пустота — честная, а не ошибка. */
export function buildOffer(
  picked: { account: AccountRotationRow | null; free: number; soon: number; tier: PoolTier | null },
  context: {
    password: string | null;
    quota: WeeklyQuota | null;
    project: string;
    today: string;
  },
): PoolOffer {
  const account = picked.account;
  if (!account) {
    return {
      account: null,
      reason: 'no_free_accounts',
      tier: null,
      free: picked.free,
      soon: picked.soon,
      project: context.project,
      today: context.today,
    };
  }
  const quota = context.quota;
  return {
    account: {
      id: account.id,
      title: account.title,
      email: account.email,
      password: context.password ?? '',
      activation_index: quota?.nextIndex ?? null,
      points_next: account.weekPointsNext,
      streak: account.weekStreak,
      next_bonus_in_days: account.weekDaysToBonus,
      used_on: account.usedOn,
      quota_exhausted: account.weekExhausted,
    },
    reason: null,
    tier: picked.tier,
    free: picked.free,
    soon: picked.soon,
    project: context.project,
    today: context.today,
  };
}

/** Откуда взялись очки и клетка в записи журнала. */
export type ActivationResolution = {
  /** Номер клетки, который записываем (1..7) или null — не знаем. */
  index: number | null;
  /** Очки, которые записываем. */
  points: number;
  /** Откуда взялись: номер назвал проект, очки прислал проект, или посчитали сами. */
  source: 'client_index' | 'client_points' | 'computed';
  /** Очки, которые мы ПРЕДСКАЗЫВАЛИ в раздаче (для сверки с фактом). */
  expectedPoints: number | null;
  /** Расходится ли факт с предсказанием — сигнал, а не ошибка. */
  mismatch: boolean;
};

/**
 * Что записать в журнал по ответу проекта.
 *
 * - **номер назвал проект** (`activation_index`) — истина: так же, как номер, названный
 *   владельцем. Очки считаются ПО НОМЕРУ (4-я и 7-я клетки — 1000, остальные 400) —
 *   ровно как в интерфейсе;
 * - **очки прислал проект** (`points`) без номера — факт панели: записываем как есть;
 *   номер считаем сами (по датам, модель не трогаем);
 * - **ничего не прислал** — и то и другое считаем сами.
 *
 * `expected` — наше предсказание (очки и клетка) ДО записи: по нему видно, разошёлся
 * ли факт с моделью. Расхождение — это сигнал (второй источник по вопросу о клетке
 * после пропущенного дня), а не повод «поправить» модель: её меняет только показание
 * панели владельца.
 */
export function resolveActivation(
  input: { points?: number | null; activationIndex?: number | null },
  quota: WeeklyQuota | null,
  expected: { points: number | null; index: number | null } = { points: null, index: null },
): ActivationResolution {
  const computedIndex = quota?.nextIndex ?? null;
  const computedPoints = computedIndex !== null ? pointsForIndex(computedIndex) : 0;

  if (input.activationIndex !== undefined && input.activationIndex !== null) {
    const points = pointsForIndex(input.activationIndex);
    return {
      index: input.activationIndex,
      points,
      source: 'client_index',
      expectedPoints: expected.points,
      mismatch:
        (expected.points !== null && expected.points !== points) ||
        (expected.index !== null && expected.index !== input.activationIndex),
    };
  }

  if (input.points !== undefined && input.points !== null) {
    return {
      index: computedIndex,
      points: input.points,
      source: 'client_points',
      expectedPoints: expected.points,
      mismatch: expected.points !== null && expected.points !== input.points,
    };
  }

  return {
    index: computedIndex,
    points: computedPoints,
    source: 'computed',
    expectedPoints: expected.points,
    mismatch: false,
  };
}
