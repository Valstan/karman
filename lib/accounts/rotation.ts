/**
 * Мультиаккаунт: правило простоя и порядок списка.
 *
 * Задача владельца (2026-11-03): аккаунты внешних сервисов, которыми он
 * переключается, пока программирует. Правило: аккаунт, который сегодня
 * использован, «тушится» до завтра — в списке он уходит вниз, наверх
 * всплывает следующий свободный.
 *
 * Грань суток — МОСКОВСКАЯ дата (Europe/Moscow, фиксированный UTC+3 без DST),
 * та же, что у напоминаний. Никакой ночной задачи: доступность считается при
 * чтении, поэтому после полуночи аккаунт сам становится свободным.
 *
 * Модуль чистый (без server-only и без БД) — юнит-тестируется.
 */

import { utcToMoscowLocal } from '@/lib/reminders/time';

/** Московская дата 'YYYY-MM-DD' для момента времени. */
export function moscowToday(now: Date = new Date()): string {
  return utcToMoscowLocal(now).slice(0, 10);
}

/** Состояние аккаунта в том виде, в котором его видит список. */
export type AccountRotationRow = {
  id: number;
  /** Название (своя метка владельца: «Матрица РМЗ — 1»). */
  title: string;
  email: string;
  /** Дата последней активации (московская 'YYYY-MM-DD') или null — не использовался. */
  usedOn: string | null;
  /** Момент последней активации (ISO UTC) или null. */
  usedAt: string | null;
  /** Проект последней активации (id / имя) — «на что ушли эти токены». */
  projectId: number | null;
  projectName: string | null;
  /** Токены за последнюю активацию. */
  lastTokens: number;
};

/** Израсходован ли аккаунт сегодня (по московской дате). */
export function isSpentToday(account: { usedOn: string | null }, today: string): boolean {
  return account.usedOn === today;
}

/**
 * Порядок списка: сначала доступные сегодня, потом израсходованные.
 *
 * Внутри доступной группы — по давноте использования: никогда не использованные
 * первыми, затем те, что использовались раньше всего. Это и есть «следующий
 * свободный аккаунт» наверху списка — тот, к которому владелец и пойдёт.
 */
export function sortAccounts<T extends AccountRotationRow>(accounts: T[], today: string): T[] {
  return [...accounts].sort((a, b) => {
    const aSpent = isSpentToday(a, today);
    const bSpent = isSpentToday(b, today);
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
