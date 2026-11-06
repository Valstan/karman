/**
 * Мультиаккаунт: правило простоя и порядок списка.
 *
 * Задача владельца (2026-11-03): аккаунты внешних сервисов, которыми он
 * переключается, пока программирует. Правило уточнено 04.11: активация
 * даёт аккаунту РОВНО 24 ЧАСА, и каждый аккаунт отсчитывает СВОИ сутки —
 * от момента активации, а не до общей полуночи по календарю. Активировали в
 * 23:50 — аккаунт свободен завтра в 23:50.
 *
 * Сессия активации: окно открывает явная кнопка «Активировать» (заказ владельца
 * 05.11: копирование почты или пароля аккаунт НЕ гасит). Пока сессия открыта,
 * повторная активация того же аккаунта её ПРОДОЛЖАЕТ: окно не сдвигается, в
 * журнале одна строка, поэтому статистика не удваивается.
 *
 * ПОЧЕМУ РОВНО 24 ЧАСА (проверено 06.11 по документации MiniMax): очки даёт
 * ЕЖЕДНЕВНЫЙ чекин (400 очков, в 4-й и 7-й дни — 1000), то есть один раз в
 * сутки на аккаунт. Вторая активация в те же московские сутки новых очков не
 * приносит, поэтому «не более одной активации в сутки» и держит окно длиннее
 * суток. Окно 18 часов (пробовали 06.11) эту гарантию ломало: вторая запись
 * в журнале считала бы очки, которых нет. Подробности — docs/minimax.md.
 *
 * Порядок экрана (заказ владельца 04.11): наверху ОДИН аккаунт — тот, что
 * дольше всех не активировался (никогда не использованный — самый первый);
 * после его активации наверх встаёт следующий. Ниже — активированные, и чем
 * позже активирован, тем выше (свежий сверху).
 *
 * Никакой ночной задачи: доступность считается при чтении, поэтому аккаунт
 * сам становится свободным по истечении своего окна.
 *
 * Модуль чистый (без server-only и без БД) — юнит-тестируется.
 */

import { utcToMoscowLocal } from '@/lib/reminders/time';

/** Сколько часов живёт активация аккаунта (окно простоя). */
export const ACTIVATION_WINDOW_HOURS = 24;

/** Окно простоя в миллисекундах. */
export const ACTIVATION_WINDOW_MS = ACTIVATION_WINDOW_HOURS * 3_600_000;

/**
 * Сколько активированных аккаунтов показывать по умолчанию (заказ владельца
 * 04.11: «последних 10 последних активированных, пусть будет так»; 05.11:
 * «оставим активированных аккаунтов не 10, а 5»). Остальные открываются кнопкой
 * «показать все аккаунты».
 */
export const ACTIVATED_PREVIEW_LIMIT = 5;

/**
 * Очки за активацию по умолчанию (заказ владельца 05.11: «обычно 400 дается,
 * но иногда 1000 — тогда я стеру 400 и напишу 1000»).
 *
 * Это очки ежедневного чекина MiniMax (400 в обычный день, 1000 в 4-й и 7-й),
 * а не токены модели: в интерфейсе поле так и называется — «Очки». Имена в БД
 * и в типах остались историческими (`tokens`) — менять их значило бы тащить
 * миграцию ради слов.
 *
 * Число подставляется в поле готовым: вводить одно и то же каждый раз не надо.
 * Пустое поле по-прежнему значит «не меняю» (прошлое значение не затирается) —
 * обнулить поле можно и руками.
 */
export const DEFAULT_ACTIVATION_TOKENS = 400;

/** Московская дата 'YYYY-MM-DD' для момента времени. */
export function moscowToday(now: Date = new Date()): string {
  return utcToMoscowLocal(now).slice(0, 10);
}

/**
 * Когда аккаунт снова станет свободен (ISO) или null — если он ещё не
 * активировался ни разу.
 */
export function availableAt(usedAt: string | null): string | null {
  if (!usedAt) return null;
  return new Date(new Date(usedAt).getTime() + ACTIVATION_WINDOW_MS).toISOString();
}

/**
 * Израсходован ли аккаунт: не истекли ли 24 часа с момента активации.
 *
 * Сравнение с моментом активации, а не с датой: у каждого аккаунта своё
 * окно (правило владельца 04.11).
 */
export function isSpent(account: { usedAt: string | null }, now: Date = new Date()): boolean {
  if (!account.usedAt) return false;
  return new Date(account.usedAt).getTime() + ACTIVATION_WINDOW_MS > now.getTime();
}

/** Состояние аккаунта в том виде, в котором его видит список. */
export type AccountRotationRow = {
  id: number;
  /** Название (своя метка владельца: «Матрица РМЗ — 1»). */
  title: string;
  email: string;
  /**
   * Москва-дата начала сессии активации ('YYYY-MM-DD') или null — не
   * активировался. В сессии не меняется: по ней ищется строка журнала.
   */
  usedOn: string | null;
  /**
   * Момент начала сессии активации (ISO UTC) или null. Окно простоя считается
   * от него, поэтому при продолжении сессии он не меняется.
   */
  usedAt: string | null;
  /** Проект последней активации (id / имя) — «на что ушли эти очки». */
  projectId: number | null;
  projectName: string | null;
  /** Очки за последнюю активацию. */
  lastTokens: number;
};

/**
 * Порядок списка: сначала доступные, потом израсходованные.
 *
 * Внутри доступной группы — по давноте использования: никогда не использованные
 * первыми, затем те, что использовались раньше всего. Это и есть «следующий
 * свободный аккаунт» наверху списка — тот, к которому владелец и пойдёт.
 *
 * Внутри израсходованных — наоборот, СВЕЖИЙ СВЕРХУ (04.11: «чем позже
 * активирован, тем выше он находится»): последний активированный аккаунт
 * должен быть сразу под верхним слотом, а не улетать вниз списка.
 */
export function sortAccounts<T extends AccountRotationRow>(
  accounts: T[],
  now: Date = new Date(),
): T[] {
  return [...accounts].sort((a, b) => {
    const aSpent = isSpent(a, now);
    const bSpent = isSpent(b, now);
    // Сначала доступные: израсходованные уходят вниз.
    if (aSpent !== bSpent) return aSpent ? 1 : -1;
    if (aSpent) {
      // Среди активированных свежий сверху.
      if (a.usedAt !== b.usedAt) return a.usedAt! < b.usedAt! ? 1 : -1;
      return a.id - b.id;
    }
    if (a.usedAt === null && b.usedAt === null) return a.id - b.id;
    // Никогда не использованный — раньше использованных.
    if (a.usedAt === null) return -1;
    if (b.usedAt === null) return 1;
    if (a.usedAt !== b.usedAt) return a.usedAt < b.usedAt ? -1 : 1;
    return a.id - b.id;
  });
}

/**
 * Разбиение списка на экране (заказ владельца 04.11).
 *
 * - `next` — ОДИН аккаунт наверху: тот, что дольше всех не активировался
 *   (никогда не использованный — самый первый). После его активации наверх
 *   встаёт следующий.
 * - `activated` — активированные, свежий сверху; по умолчанию показываются
 *   первые `ACTIVATED_PREVIEW_LIMIT`, остальные — по кнопке «показать все».
 * - `queued` — остальные свободные (в очереди за следующим).
 */
export type AccountSplit<T> = {
  /** Следующий свободный аккаунт — верхний слот. */
  next: T | null;
  /** Активированные, свежий сверху. */
  activated: T[];
  /** Остальные свободные — в очереди. */
  queued: T[];
};

export function splitAccounts<T extends AccountRotationRow>(
  accounts: T[],
  now: Date = new Date(),
): AccountSplit<T> {
  const sorted = sortAccounts(accounts, now);
  const free: T[] = [];
  const activated: T[] = [];
  for (const account of sorted) {
    if (isSpent(account, now)) activated.push(account);
    else free.push(account);
  }
  const [next, ...queued] = free;
  return { next: next ?? null, activated, queued };
}

/** Строка журнала активаций. */
export type UsageRow = {
  projectId: number | null;
  projectName: string | null;
  tokens: number;
};

/** Сводка по проекту: сколько активаций и сколько токенов. */
export type ProjectUsage = {
  projectId: number | null;
  projectName: string | null;
  activations: number;
  tokens: number;
};

/**
 * Свод по проектам: «на какой проект больше токенов». Считается по журналу
 * активаций, а не по текущему состоянию аккаунтов — иначе повторное
 * использование того же аккаунта затирало бы прошлый расход.
 *
 * Порядок — по токенам (главный вопрос владельца), при равенстве — по числу
 * активаций.
 */
export function aggregateUsage(rows: UsageRow[]): ProjectUsage[] {
  const byProject = new Map<number | null, ProjectUsage>();
  for (const row of rows) {
    const current = byProject.get(row.projectId) ?? {
      projectId: row.projectId,
      projectName: row.projectName,
      activations: 0,
      tokens: 0,
    };
    current.activations += 1;
    current.tokens += row.tokens;
    byProject.set(row.projectId, current);
  }
  return [...byProject.values()].sort(
    (a, b) => b.tokens - a.tokens || b.activations - a.activations || (a.projectName ?? '').localeCompare(b.projectName ?? ''),
  );
}
