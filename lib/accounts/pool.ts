/**
 * Раздача пула MiniMax проектам по HTTP — ЧИСТАЯ часть (без БД и без server-only).
 *
 * ## Карусель одна (заказ владельца 20.11)
 *
 * «Сделай одну карусель без разделения, и выдавай всем проектам и прод и
 * программированию просто то что есть… Просит токен, ты берешь токен,
 * активируешь на нем бонус какой там есть, и если он активировался, то отдаешь
 * потребителю, а если не активировался, то аккаунт отправляешь в конец очереди
 * карусели и берешь новый токен по порядку и снова пытаешься активировать бонус».
 *
 * Отсюда три правила, и все три — здесь:
 *
 * 1. **Одна очередь.** Никакого деления на «тысячные» и «четырёхсотковые», никакого
 *    приоритета по потребителю (прод / программирование). Пул крутится простым
 *    перебором: кто дольше всех не выдавался — тот первый.
 * 2. **Очки при выборе НЕ проверяются.** Проверка очков переехала туда, где
 *    единственно можно её сделать честно: в забор `signin/claim` в момент выдачи
 *    (см. `lib/services/minimax.ts`). Панель остатка не отдаёт — «сколько очков
 *    осталось» по ней не определить, поэтому обещание «400 очков» по модели клетки
 *    было обещанием, которое не сдержалось (модель с панелью разошлась у 274 строк
 *    леджера из 416).
 * 3. **Выданный аккаунт уезжает в конец очереди** — независимо от времени суток.
 *    Это уже устроено сортировкой по времени последней выдачи (`stalenessCompare`).
 *
 * ## Факт вместо прогноза
 *
 * Ответ на забор (`POST signin/claim`) — единственный верный признак «есть ли на
 * аккаунте очки»: `claim_result = 1` — забрали мы (очки наши и свежие),
 * `claim_result = 2` — клетку забрали до нас (очки потрачены). Никакой модели
 * клетки в обещании потребителю больше нет: клетка и номинал берутся из ответа
 * вендора (см. `ClaimFact`).
 *
 * ## Почему подбор аккаунта и правило клетки живут не здесь
 *
 * Подбор — `lib/accounts/rotation.ts`, квота — `lib/accounts/weekly.ts`. Здесь
 * только: кто первый в карусели, что мы обещаем потребителю и что пишем в журнал,
 * когда проект прислал свой номер клетки или фактические очки.
 *
 * Модуль чистый — юнит-тестируется без БД.
 */

import {
  accountPoolSummary,
  hasThousandCell,
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
  /** Клетка вендора (1..7) — из ответа на забор, или null — вендор не ответил. */
  activation_index: number | null;
  /** Номинал клетки (400 / 1000) — из ответа на забор, или null — не знаем. */
  points_next: number | null;
  /** Текущая серия дней подряд. */
  streak: number;
  /** Через сколько дней будет бонусная клетка (1000 очков). */
  next_bonus_in_days: number;
  /** Москва-дата последней активации или null — аккаунт не активировался. */
  used_on: string | null;
  /** Исчерпана ли неделя аккаунта (7 из 7) — тогда его не предлагают. */
  quota_exhausted: boolean;
  /** Под вопросом ли клетка. При заборе в момент выдачи вопроса нет: клетку знаем. */
  unverified: boolean;
  /** Откуда взялись клетка и очки: ответ вендора на забор. */
  hint_source: 'owner_confirmed' | 'model' | 'panel';
};

/** Ответ на «дай аккаунт»: аккаунт (или честная пустота) + состояние пула. */
export type PoolOffer = {
  /** Аккаунт к активации или null — сегодня брать нечего. */
  account: PoolHandout | null;
  /** Почему аккаунта нет (когда account === null). */
  reason: 'no_free_accounts' | 'no_tokens_ready' | 'no_handable_accounts' | null;
  /** Очковый класс отданного аккаунта — по ФАКТУ забора, а не по модели. */
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
   * Токен агента этого аккаунта — **access** (мандат владельца 14.11: «отдавай ему
   * только по одному токену»; пара целиком не отдаётся, refresh остаётся у нас).
   *
   * Поле появляется только когда access есть, ещё не отдан и не протух (access живёт
   * 12 часов). `expires_at_ms` — честный срок от MiniMax.
   */
  access_token?: string;
  expires_at_ms?: number;
};

/**
 * Очковый класс отданного аккаунта.
 *
 * Класса-«карусели» больше нет: одна очередь, и класс в ответе — это ФАКТ о том,
 * сколько очков нёс аккаунт (по ответу вендора на забор), а не признак, по
 * которому мы что-то отбираем. `points_0` и `unverified` остались в типе ради
 * совместимости ответа: в новой схеме не возникают — очки мы проверяем забором.
 */
export type PoolTier = 'points_400' | 'points_1000' | 'points_0' | 'unverified';

/**
 * Строка аккаунта для подбора: как в списке, плюс недельная квота.
 *
 * Квота обязательна: по ней считается серия и «до бонуса N дн.». Без неё в ответе
 * было бы пусто, хуже отсутствия.
 */
export type PoolRow = AccountRotationRow & {
  /** Недельная квота аккаунта. */
  week: WeeklyQuota;
};

/**
 * ФАКТ забора бонуса в момент выдачи — ответ вендора на `POST signin/claim`.
 *
 * Это единственный честный признак «есть ли на аккаунте очки»: панель остатка не
 * отдаёт, а модель клетки по датам с панелью расходилась (274 строки леджера из
 * 416 на 20.11).
 */
export type ClaimFact = {
  /** Клетка вендора (1..7) или null — вендор не ответил. */
  index: number | null;
  /** Номинал клетки (400 / 1000) или null — не знаем. */
  points: number | null;
  /** 1 — забрали мы сейчас, 2 — клетку забрали до нас. */
  result: number;
  /** Идентификатор забора вендора (один на сутки). */
  claimId: string | null;
};

/** Очковый класс по номиналу клетки (факт забора). */
export function tierOfPoints(points: number | null): PoolTier {
  if (points === null) return 'points_0';
  return points >= 1000 ? 'points_1000' : 'points_400';
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
  /**
   * Область потребителя (заголовок `X-MiniMax-Area`) — в аудит: кто и под что брал.
   * В журнал не пишется: журнальный проект — это ПОТРЕБИТЕЛЬ (комната, из которой
   * пришёл запрос), а область — его внутренняя разметка.
   */
  area?: string | null;
  /**
   * Своё имя проекта у потребителя (заголовок `X-MiniMax-Project`) — в аудит.
   *
   * В журнал не пишется: журнальный проект — всегда комната-потребитель (так расход
   * Сарафана и расход панели программирования не смешиваются), а это — разметка
   * потребителя внутри себя.
   */
  project?: string | null;
};

/**
 * Верхний слот пула — **одна карусель** (заказ владельца 20.11).
 *
 * - Порядок — по времени последней выдачи: кто дольше всех не выдавался — тот
 *   первый. Каждый выданный аккаунт уезжает в конец, и карусель крутится.
 * - Никакого деления на 400/1000 и никакого приоритета по потребителю: прод и
 *   программирование берут из одной очереди.
 * - **Очки не проверяются.** Аккаунт, у которого очки уже потратил потребитель,
 *   попадёт в выдачу, но его отсечёт забор `signin/claim` в момент выдачи
 *   (`claim_result = 2`) — аккаунт уедет в конец очереди, и мы возьмём следующий.
 *
 * Занятые (сессия открыта) и аккаунты с исчерпанной неделей в выдачу не попадают.
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
  reason: 'no_free_accounts' | 'no_tokens_ready' | 'no_handable_accounts' | null;
} {
  // Счётчик свободных — по карусели: очки здесь не проверяются (см. выше).
  const summary = accountPoolSummary(accounts, now, { pointsMatter: false });
  const exclude = new Set(filters.excludeIds ?? []);
  const emails = filters.emails
    ? new Set(filters.emails.map((mail) => mail.trim().toLowerCase()).filter(Boolean))
    : null;
  const tokenReady = filters.tokenReadyIds ? new Set(filters.tokenReadyIds) : null;

  const sorted = sortAccounts(accounts, now);
  const free = sorted.filter((account) => {
    if (isUnavailable(account, now, { pointsMatter: false })) return false;
    if (exclude.has(account.id)) return false;
    if (emails && !emails.has(account.email.trim().toLowerCase())) return false;
    return true;
  });
  // Аккаунты с добытой парой токенов — единственные, с которыми проект может
  // работать: вход в MiniMax делает владелец, пароля у проекта нет.
  const usable = tokenReady ? free.filter((account) => tokenReady.has(account.id)) : free;

  // КАРУСЕЛЬ: по времени последней выдачи (никогда не выдавался — первый), тем
  // самым выданный уезжает в конец и возвращается, только когда очередь до него
  // дойдёт.
  const account = [...usable].sort(stalenessCompare)[0] ?? null;
  if (account) {
    return { account, free: summary.free, soon: summary.soon, tier: null, reason: null };
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

/**
 * Сколько аккаунтов готовы к выдаче — для кнопки выдачи в интерфейсе владельца.
 *
 * Одна карусель — одно число (заказ владельца 20.11: две кнопки на 400 и на 1000
 * больше не нужны). В счёт идут только аккаунты с добытой парой токенов: без пары
 * отдавать нечего (вход в MiniMax делает владелец).
 *
 * Очки здесь не проверяются — их проверяет забор в момент выдачи.
 */
export function availableCount(
  accounts: PoolRow[],
  now: Date = new Date(),
  tokenReadyIds?: ReadonlySet<number> | number[],
): number {
  const ready = tokenReadyIds ? new Set(tokenReadyIds) : null;
  let count = 0;
  for (const account of accounts) {
    // Занятый (окно простоя не истекло) и с исчерпанной неделей в выдачу не идут —
    // ровно те же правила, что у отдачи в пуле.
    if (isUnavailable(account, now, { pointsMatter: false })) continue;
    if (ready && !ready.has(account.id)) continue;
    count += 1;
  }
  return count;
}

/**
 * Давность выдачи: чем дольше аккаунт не выдавался, тем он «свежее» для выдачи.
 * Никогда не выдававшийся — самый свежий.
 *
 * **Тысячная клетка — в начало** (заказ владельца 21.11: «собирай 1000-ные
 * аккаунты в начале очереди карусели, чтобы их использовать в первую очередь»).
 * Клетка — это номинал сегодняшнего чек-ина: 1000 у клеток 4 и 7, 400 у остальных.
 * Эти очки лежат на аккаунте до выдачи и тратятся в его недельном окне, поэтому
 * тысячный аккаунт отдаём первым: за то же число выданных аккаунтов потребитель
 * получает больше очков. Номинал — из леджера (`bonusPoints`), это ответ вендора на
 * забор в 05:00, а не модель клетки.
 *
 * **Клетку забрал потребитель — аккаунт в конец очереди** (заказ владельца 20.11:
 * «если не активировался, то аккаунт отправляешь в конец очереди карусели»).
 * Очки такого аккаунта уже потрачены, и до следующих суток он в заборе не
 * разбудится: пусть ждёт в хвосте, а не спорит с живыми за начало очереди.
 */
function stalenessCompare(a: PoolRow, b: PoolRow): number {
  const aDead = a.bonusOurs === false;
  const bDead = b.bonusOurs === false;
  if (aDead !== bDead) return aDead ? 1 : -1;
  const aThousand = hasThousandCell(a);
  const bThousand = hasThousandCell(b);
  if (aThousand !== bThousand) return aThousand ? -1 : 1;
  if (a.usedAt === null && b.usedAt === null) return a.id - b.id;
  if (a.usedAt === null) return -1;
  if (b.usedAt === null) return 1;
  if (a.usedAt !== b.usedAt) return a.usedAt < b.usedAt ? -1 : 1;
  return a.id - b.id;
}

/**
 * Человеческое объяснение выбора — «почему он, а не следующий».
 *
 * Brain (13.11): «не хватает только пометки, кто первый, и человеческого объяснения
 * (почему он, а не следующий)». Раздатчику-проекту разбор очков не нужен, а
 * владельцу — нужен.
 */
export function explainChoice(account: PoolRow, fact: ClaimFact | null): string {
  const parts: string[] = [];
  parts.push('первый в карусели — выдаём по кругу, без разделения на 400 и 1000');
  if (fact) {
    if (fact.result === 1) {
      parts.push(`бонус забрали при выдаче: клетка ${fact.index ?? '-'} — ${fact.points ?? '-'} очков`);
    } else {
      parts.push('клетку забрали раньше — очки уже потрачены');
    }
  }
  if (account.weekStreak > 0) parts.push(`серия ${account.weekStreak} дн. подряд`);
  parts.push(`до бонуса ${account.weekDaysToBonus} дн.`);
  return parts.join('; ');
}

/** Сборка ответа: аккаунт + состояние пула. Пустота — честная, а не ошибка. */
export function buildOffer(
  picked: {
    account: PoolRow | null;
    free: number;
    soon: number;
    tier: PoolTier | null;
    reason?: 'no_free_accounts' | 'no_tokens_ready' | 'no_handable_accounts' | null;
  },
  context: {
    project: string;
    today: string;
    /** Факт забора в момент выдачи: клетка и номинал — из ответа вендора. */
    fact?: ClaimFact | null;
    /** Момент, на котором считаем «занят ли аккаунт»; по умолчанию — сейчас. */
    now?: Date;
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
  const fact = context.fact ?? null;
  return {
    account: {
      id: account.id,
      title: account.title,
      email: account.email,
      activation_index: fact?.index ?? null,
      points_next: fact?.points ?? null,
      streak: account.weekStreak,
      next_bonus_in_days: account.weekDaysToBonus,
      used_on: account.usedOn,
      quota_exhausted: account.weekExhausted,
      // Клетку мы знаем: она пришла из ответа вендора на забор.
      unverified: false,
      hint_source: 'panel',
    },
    reason: null,
    tier: picked.tier ?? tierOfPoints(fact?.points ?? null),
    // Аккаунт один — он и есть рекомендованный.
    recommended: true,
    why: explainChoice(account, fact),
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
