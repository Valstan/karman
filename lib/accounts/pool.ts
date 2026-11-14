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
 *   (`sortAccounts` → первый свободный), то есть «самый подходящий» означает ровно то,
 *   что владелец видит наверху своего списка;
 * - считается, сколько очков даст активация (`pointsForIndex` от клетки) и какая
 *   клетка ожидается;
 * - решается, что записать в журнал, когда проект прислал свой номер клетки или
 *   фактические очки.
 *
 * ## Подсказка по очкам — от числа, названного владельцем (письмо brain 13.11)
 *
 * Пока владелец не называл клетку руками, подсказку считали по датам. Но 09.11
 * программа предлагала клетки 4, 5 и 7, а настоящая панель MiniMax показывала 1 и 2 —
 * и владелец переопределял 36 раз из 39 (08.11 — 52 из 66). Число, названное
 * владельцем, — это **наблюдение с панели**, то есть истина; программная модель по
 * датам с ним тогда не совпадала.
 *
 * Поэтому подсказка считается так: **если владелец называл клетку для последней
 * активации — берём ЕГО число и прибавляем один** (панель считает клетки подряд), а
 * если не называл — считаем по датам, как раньше. Правило учёта при этом НЕ
 * меняется: в журнал по-прежнему пишется то, что назвал владелец, и модель по датам
 * остаётся прежней. Это не «правило уезжает» — это «мы не спорим с показанием
 * панели, а свои расхождения помечаем флагом».
 *
 * ## Один аккаунт под вопросом — подсказку по нему не даём
 *
 * Аккаунт 3@ (id 86) — единственный, по которому правило клетки после пропущенного
 * дня открыто (два ручных ввода владельца расходятся с моделью; панели этого
 * аккаунта ещё нет). «Не проверен» честнее, чем уверенно неверно: очки могут сгореть
 * вхолостую. Поэтому для него `points_next` не отдаётся, а ответ помечается
 * `unverified: true`. Когда панель придёт — пункт снимается.
 *
 * Модуль чистый — юнит-тестируется без БД.
 */

import {
  accountPoolSummary,
  isUnavailable,
  sortAccounts,
  type AccountRotationRow,
} from './rotation';
import {
  WEEKLY_ACTIVATION_LIMIT,
  pointsForIndex,
  type WeeklyQuota,
} from './weekly';

/**
 * Аккаунты с открытым вопросом по правилу клетки: подсказку по очкам для них НЕ
 * отдаём (см. шапку модуля). Идентификатор устойчив, название меняется, а id нет.
 */
export const UNVERIFIED_CELL_ACCOUNT_IDS: ReadonlySet<number> = new Set([86]);

/** Что именно отдаём проекту. Ровно то, что нужно для активации. */
export type PoolHandout = {
  /** id аккаунта в базе владельца. */
  id: number;
  /** Своя метка владельца («Матрица РМЗ — 12»). */
  title: string;
  /** Почта аккаунта — ею проект входит в MiniMax. */
  email: string;
  /** Клетка, которую мы ждём от этого аккаунта (1..7) или null — не знаем. */
  activation_index: number | null;
  /** Сколько очков даст активация: 1000 (клетка 4 или 7), 400 — обычный день, 0 — чек-ин за сегодня уже был. null — подсказки нет (аккаунт под вопросом). */
  points_next: number | null;
  /** Текущая серия дней подряд. */
  streak: number;
  /** Через сколько дней будет бонусная клетка (1000 очков). */
  next_bonus_in_days: number;
  /** Москва-дата последней активации или null — аккаунт не активировался. */
  used_on: string | null;
  /** Исчерпана ли неделя аккаунта (7 из 7) — тогда его не предлагают. */
  quota_exhausted: boolean;
  /** Аккаунт под вопросом по правилу клетки — подсказку по очкам не даём. */
  unverified: boolean;
  /** Откуда взялась клетка-подсказка: число, названное владельцем, или наша модель. */
  hint_source: 'owner_confirmed' | 'model';
};

/** Ответ на «дай аккаунт»: аккаунт (или честная пустота) + состояние пула. */
export type PoolOffer = {
  /** Аккаунт к активации или null — сегодня брать нечего. */
  account: PoolHandout | null;
  /** Почему аккаунта нет (когда account === null). */
  reason: 'no_free_accounts' | 'no_tokens_ready' | null;
  /** Из какого класса выдан аккаунт. */
  tier: PoolTier | null;
  /** Аккаунт первый — его и предлагаем активировать сейчас. */
  recommended: boolean;
  /** Почему он: человеческим языком, без «по правилу сортировки». */
  why: string | null;
  /** Сколько аккаунтов свободно прямо сейчас (включая предложенный). */
  free: number;
  /** Сколько освободится в ближайшие полчаса. */
  soon: number;
  /** Кто получил (имя комнаты проекта). */
  project: string;
  /** Сегодняшняя московская дата — по ней «день активации». */
  today: string;
  /**
   * Пара токенов агента этого аккаунта — отдаётся ОДИН раз (refresh у MiniMax
   * одноразовый): после отдачи свой refresh мы не крутим никогда, а проект присылает
   * обновлённую пару обратно. Поля появляются только когда пара есть и ещё не отдана.
   */
  access_token?: string;
  refresh_token?: string;
  expires_at_ms?: number;
};

/**
 * Какой очковый класс отдан проекту.
 *
 * Правило владельца (13.11): **Сарафану — аккаунты, с которых сегодня можно взять
 * 400 очков; аккаунты на 1000 очков владелец оставляет себе** (комп, программирование)
 * и отдаёт проекту только в крайнем случае — когда свободных четырёхсотых не
 * осталось.
 *
 * Третий класс — аккаунты, уже отмеченные сегодня (очки 0): они не стоят владельцу
 * ничего, но и проекту очков не дают, поэтому идут последними. Четвёртый — аккаунт
 * под вопросом (правило клетки): класса у него неизвестно, поэтому он в самом конце.
 */
export type PoolTier = 'points_400' | 'points_1000' | 'points_0' | 'unverified';

/**
 * Строка аккаунта для подбора: как в списке, плюс недельная квота.
 *
 * Квота обязательна: подсказка по очкам считается из неё (число, названное владельцем,
 * живёт там же). Без неё подсказка была бы «0 очков» — тихая ложь, хуже отсутствия.
 */
export type PoolRow = AccountRotationRow & {
  /** Недельная квота аккаунта — из неё берётся названное владельцем число. */
  week: WeeklyQuota;
};

/** Что мы советуем по этому аккаунту: клетка, очки и откуда они. */
export type PoolHint = {
  index: number | null;
  points: number | null;
  source: 'owner_confirmed' | 'model';
  unverified: boolean;
};

/**
 * Подсказка по аккаунту: клетка и очки.
 *
 * - **число, названное владельцем** (панель — истина) важнее нашей модели по датам:
 *   если владелец называл клетку для последней активации, следующая = его число + 1;
 * - если не называл — считаем по датам, как раньше;
 * - если аккаунт под вопросом — подсказки нет вовсе (`points_next: null`).
 */
export function hintFor(row: PoolRow): PoolHint {
  const quota = row.week ?? null;
  const unverified = UNVERIFIED_CELL_ACCOUNT_IDS.has(row.id);
  const modelIndex = quota?.nextIndex ?? null;
  // Число, названное владельцем на панели, — истина; наша модель по датам с ним тогда
  // расходилась (36 переопределений из 39 на 09.11). Берём его, только если серия жива
  // (последняя отметка — сегодня или вчера): после пропущенного дня клетка начинается
  // заново, а вот КАК — открытый вопрос по 3@ (см. UNVERIFIED_CELL_ACCOUNT_IDS).
  const ownerIndex =
    quota && quota.streak >= 1 && quota.confirmedIndex !== null
      ? (quota.confirmedIndex % WEEKLY_ACTIVATION_LIMIT) + 1
      : null;
  const index = ownerIndex ?? modelIndex;
  if (unverified) {
    return {
      index,
      points: null,
      source: ownerIndex !== null ? 'owner_confirmed' : 'model',
      unverified,
    };
  }
  // Чек-ин за сегодня уже был — очков сегодня не будет ни при какой клетке.
  const points = row.weekCheckedInToday ? 0 : index !== null ? pointsForIndex(index) : 0;
  return {
    index,
    points,
    source: ownerIndex !== null ? 'owner_confirmed' : 'model',
    unverified,
  };
}

/** Фильтры запроса: что проекту не подходит. */
export type PoolFilters = {
  /** id аккаунтов, которые проекту не подходят (он их уже пробовал). */
  excludeIds?: number[];
  /** Почты, которые у проекта есть: отдаём только такие аккаунты. */
  emails?: string[];
  /**
   * id аккаунтов, у которых пара токенов уже добыта и её ещё можно отдать.
   *
   * Схема 14.11: вход в MiniMax делает владелец (программного логина по паролю у
   * MiniMax нет — `grant_type=password` → 400), а проект работает с **нашей** парой
   * токенов. Значит аккаунт без добытой пары проекту бесполезен: отдавать такой нельзя,
   * иначе проект упрётся в «нет токена» на живом аккаунте.
   */
  tokenReadyIds?: number[];
};

/**
 * Верхний слот пула — тот же, что показывается владельцу наверху списка, но с
 * фильтром по очкам (правило владельца 13.11): проекту отдаётся аккаунт на **400**
 * очков; аккаунт на **1000** — только если свободных четырёхсотых не осталось;
 * уже отмеченные сегодня (0 очков) — последним резервом; аккаунт под вопросом — в
 * самом конце.
 *
 * Правило выбора внутри класса — прежнее, из `rotation.ts`: сначала активация, которая
 * даст 1000 (клетка 4 или 7), потом та, до бонуса которой ближе всего, потом длинная
 * серия, потом давность. Занятые окном (5 ч) и аккаунты с исчерпанной неделей в выдачу
 * не попадают.
 */
export function pickPoolAccount<T extends PoolRow>(
  accounts: T[],
  now: Date = new Date(),
  filters: PoolFilters = {},
): {
  account: T | null;
  free: number;
  soon: number;
  tier: PoolTier | null;
  reason: 'no_free_accounts' | 'no_tokens_ready' | null;
} {
  const summary = accountPoolSummary(accounts, now);
  const exclude = new Set(filters.excludeIds ?? []);
  const emails = filters.emails
    ? new Set(filters.emails.map((mail) => mail.trim().toLowerCase()).filter(Boolean))
    : null;
  const tokenReady = filters.tokenReadyIds ? new Set(filters.tokenReadyIds) : null;

  const sorted = sortAccounts(accounts, now);
  const free = sorted.filter((account) => {
    if (isUnavailable(account, now)) return false;
    if (exclude.has(account.id)) return false;
    if (emails && !emails.has(account.email.trim().toLowerCase())) return false;
    return true;
  });
  // Аккаунты с добытой парой токенов — единственные, с которыми проект может
  // работать: вход в MiniMax делает владелец, пароля у проекта нет.
  const usable = tokenReady ? free.filter((account) => tokenReady.has(account.id)) : free;

  const pick = (tier: PoolTier): T | null =>
    usable.find((account) => tierOf(account) === tier) ?? null;

  const four = pick('points_400');
  if (four) {
    return { account: four, free: summary.free, soon: summary.soon, tier: 'points_400', reason: null };
  }
  const thousand = pick('points_1000');
  if (thousand) {
    return {
      account: thousand,
      free: summary.free,
      soon: summary.soon,
      tier: 'points_1000',
      reason: null,
    };
  }
  const zero = pick('points_0');
  if (zero) {
    return { account: zero, free: summary.free, soon: summary.soon, tier: 'points_0', reason: null };
  }
  const unverified = pick('unverified');
  if (unverified) {
    return {
      account: unverified,
      free: summary.free,
      soon: summary.soon,
      tier: 'unverified',
      reason: null,
    };
  }
  return {
    account: null,
    free: summary.free,
    soon: summary.soon,
    tier: null,
    // Свободные аккаунты есть, но без добытой пары токенов — отдавать нечего.
    reason: tokenReady && free.length > 0 ? 'no_tokens_ready' : 'no_free_accounts',
  };
}

/** Очковый класс аккаунта — по ПОДСКАЗКЕ (то, что покажет и панель). */
function tierOf(account: PoolRow): PoolTier {
  const hint = hintFor(account);
  if (hint.unverified) return 'unverified';
  if (hint.points === 1000) return 'points_1000';
  if (hint.points === 400) return 'points_400';
  return 'points_0';
}

/**
 * Человеческое объяснение выбора — «почему он, а не следующий».
 *
 * Brain (13.11): «не хватает только пометки, кто первый, и человеческого объяснения
 * (почему он, а не следующий)». Раздатчику-проекту разбор очков не нужен, а
 * владельцу — нужен.
 */
export function explainChoice(account: PoolRow, hint: PoolHint, tier: PoolTier): string {
  const parts: string[] = [];
  if (hint.unverified) {
    parts.push('не проверен: клетка этого аккаунта под вопросом, подсказку по очкам не даём');
    return parts.join('; ');
  }
  if (hint.points === 0) {
    parts.push('чек-ин за сегодня уже был — очков сегодня не даст, окно расхода откроет');
  } else {
    parts.push(`клетка ${hint.index ?? '-'} — сегодня ${hint.points} очков`);
  }
  if (hint.source === 'owner_confirmed') {
    parts.push('клетка посчитана от числа, названного вами на панели');
  }
  if (account.weekStreak > 0) parts.push(`серия ${account.weekStreak} дн. подряд`);
  parts.push(`до бонуса ${account.weekDaysToBonus} дн.`);
  if (tier === 'points_400') {
    parts.push('свободных четырёхсотовых хватило — тысячные оставляем владельцу');
  } else if (tier === 'points_1000') {
    parts.push('свободных четырёхсотовых не осталось — отдаём тысячник');
  }
  return parts.join('; ');
}

/** Сборка ответа: аккаунт + состояние пула. Пустота — честная, а не ошибка. */
export function buildOffer(
  picked: {
    account: PoolRow | null;
    free: number;
    soon: number;
    tier: PoolTier | null;
    reason?: 'no_free_accounts' | 'no_tokens_ready' | null;
  },
  context: {
    project: string;
    today: string;
  },
): PoolOffer {
  const account = picked.account;
  if (!account) {
    return {
      account: null,
      reason: picked.reason ?? 'no_free_accounts',
      tier: null,
      recommended: false,
      why: null,
      free: picked.free,
      soon: picked.soon,
      project: context.project,
      today: context.today,
    };
  }
  const hint = hintFor(account);
  return {
    account: {
      id: account.id,
      title: account.title,
      email: account.email,
      activation_index: hint.index,
      points_next: hint.points,
      streak: account.weekStreak,
      next_bonus_in_days: account.weekDaysToBonus,
      used_on: account.usedOn,
      quota_exhausted: account.weekExhausted,
      unverified: hint.unverified,
      hint_source: hint.source,
    },
    reason: null,
    tier: picked.tier,
    // Аккаунт один — он и есть рекомендованный.
    recommended: true,
    why: explainChoice(account, hint, picked.tier ?? 'points_0'),
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
  /** Очки, которые мы ПРЕДСКАЗЫВАЛИ (для сверки с фактом). */
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
