import 'server-only';

import { and, asc, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { prompt } from '@/lib/db/schema';
import { derivePromptTitle, normalizePromptText } from '@/lib/prompts/normalize';
import type { PromptItem, PromptProjectSummary, PromptSource } from '@/lib/prompts/types';

export type { PromptItem, PromptProjectSummary, PromptSource } from '@/lib/prompts/types';

/**
 * Библиотерия промтов (заказ владельца 2026-11-06).
 *
 * Промты раскладываются по проектам (раздел списка) и живут в двух состояниях:
 * живые (archived_at IS NULL) и архивные (archived_at проставлен). Архив — не
 * удаление: строка остаётся в таблице, потому что владелец просил сохранять
 * промты «на будущее — мало ли где пригодится, может быть, для обучения или
 * для какой-то истории». Удаление из архива — ручное действие из интерфейса.
 *
 * Таблица одна на приложение (без user_id): библиотека общая, как карта
 * проектов. Право записи — у владельца (суперпользователя) и у машинного
 * канала Мозга; проверка права живёт в слое действий и в API, не здесь.
 */

function toItem(row: typeof prompt.$inferSelect): PromptItem {
  return {
    id: row.id,
    project: row.project,
    title: row.title,
    body: row.body,
    source: row.source,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
  };
}

/**
 * Список промтов: живые или архивные, по разделам.
 *
 * Порядок — по проекту (без учёта регистра) и по убыванию времени создания:
 * внутри раздела свежие сверху, разделы идут в алфавитном порядке, чтобы их
 * не нужно было искать глазами.
 */
export async function listPrompts(options: {
  archived: boolean;
  project?: string;
}): Promise<PromptItem[]> {
  const state = options.archived ? isNotNull(prompt.archivedAt) : isNull(prompt.archivedAt);
  const projectFilter = options.project ? eq(prompt.project, options.project) : undefined;
  const rows = await db
    .select()
    .from(prompt)
    .where(and(state, projectFilter))
    .orderBy(asc(sql`lower(${prompt.project})`), desc(prompt.createdAt), desc(prompt.id));
  return rows.map(toItem);
}

/**
 * Сводка по разделам: сколько живых промтов в каждом проекте.
 *
 * Нужна странице, чтобы показать «сколько накопилось» рядом с разделом и
 * не дать владельцу искать нужный проект перебором.
 */
export async function summarizePromptProjects(): Promise<PromptProjectSummary[]> {
  const rows = await db
    .select({
      project: prompt.project,
      count: sql<number>`count(*)::int`,
    })
    .from(prompt)
    .where(isNull(prompt.archivedAt))
    .groupBy(prompt.project)
    .orderBy(asc(sql`lower(${prompt.project})`));
  return rows.map((row) => ({ project: row.project, count: row.count }));
}

/**
 * Создаёт промт.
 *
 * Тело нормализуется детерминированно (lib/prompts/normalize.ts): CRLF → LF,
 * висячие пробелы, лишние пустые строки. Смысл текста не трогается — этим
 * занимался Мозг до отправки.
 */
export async function createPrompt(
  input: { project: string; title?: string; body: string },
  source: PromptSource = 'manual',
): Promise<PromptItem> {
  const body = normalizePromptText(input.body);
  const title = input.title?.trim() ? input.title.trim() : derivePromptTitle(body);
  const [row] = await db
    .insert(prompt)
    .values({
      project: input.project.trim(),
      title,
      body,
      source,
    })
    .returning();
  if (!row) {
    throw new Error('промт не записался');
  }
  return toItem(row);
}

/**
 * Отправляет промт в архив или возвращает его в живые.
 *
 * Возвращает false, если такой строки уже нет (удалили в другой вкладке) —
 * вызывающий код покажет «не найдено», а не «ошибка».
 */
export async function setPromptArchived(id: number, archived: boolean): Promise<boolean> {
  const [row] = await db
    .update(prompt)
    .set({ archivedAt: archived ? new Date().toISOString() : null })
    .where(eq(prompt.id, id))
    .returning({ id: prompt.id });
  return Boolean(row);
}

/** Удаляет промт насовсем (используется только для архивных). */
export async function deletePrompt(id: number): Promise<boolean> {
  const [row] = await db.delete(prompt).where(eq(prompt.id, id)).returning({ id: prompt.id });
  return Boolean(row);
}

/**
 * Очистка архива: удаляет архивные промты (все или старше даты).
 *
 * Возвращает число удалённых строк — интерфейс показывает, сколько именно
 * убрано, чтобы «очистить» не выглядело как чёрный ящик.
 */
export async function purgeArchivedPrompts(before?: string): Promise<number> {
  const conditions = [isNotNull(prompt.archivedAt)];
  if (before) {
    conditions.push(lt(prompt.archivedAt, `${before} 00:00:00+00`));
  }
  const rows = await db
    .delete(prompt)
    .where(and(...conditions))
    .returning({ id: prompt.id });
  return rows.length;
}

/** Сколько строк в архиве — показывается рядом с кнопкой «Очистить архив». */
export async function countArchivedPrompts(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(prompt)
    .where(isNotNull(prompt.archivedAt));
  return row?.count ?? 0;
}
