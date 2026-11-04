/**
 * Мультиаккаунт: правило простоя и порядок списка.
 *
 * Задача владельца (2026-11-03): аккаунты внешних сервисов, которыми он
 * переключается, пока программирует. Правило уточнено 04.11: активация
 * даёт аккаунту РОВНО 24 ЧАСА, и каждый аккаунт отсчитывает СВОИ сутки —
 * от момента активации, а не до общей полуночи по календарю. Активировали в
 * 23:50 — аккаунт свободен завтра в 23:50.
 *
 * Сессия активации: с первого копирования открывается окно в 24 часа.
 * Копирование пароля после копирования почты — ПРОДОЛЖЕНИЕ той же сессии
 * (окно не сдвигается, в журнале одна строка), поэтому «почта, потом пароль»
 * по-прежнему работает и статистика не удваивается.
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
  /** Проект последней активации (id / имя) — «на что ушли эти токены». */
  projectId: number | null;
  projectName: string | null;
  /** Токены за последнюю активацию. */
  lastTokens: number;
};

/**
 * Порядок списка: сначала доступные, потом израсходованные.
 *
 * Внутри доступной группы — по давноте использования: никогда не использованные
 * первыми, затем те, что использовались раньше всего. Это и есть «следующий
 * свободный аккаунт» наверху списка — тот, к которому владелец и пойдёт.
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
    if (a.usedAt === null && b.usedAt === null) return a.id - b.id;
    // Никогда не использованный — раньше использованных.
    if (a.usedAt === null) return -1;
    if (b.usedAt === null) return 1;
    if (a.usedAt !== b.usedAt) return a.usedAt < b.usedAt ? -1 : 1;
    return a.id - b.id;
  });
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
