import 'server-only';

import { and, asc, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { authUser, prompt } from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import { derivePromptTitle, normalizePromptText } from '@/lib/prompts/normalize';
import type { PromptItem, PromptProjectSummary, PromptSource } from '@/lib/prompts/types';

export type { PromptItem, PromptProjectSummary, PromptSource } from '@/lib/prompts/types';

/**
 * Библиотека промтов (заказ владельца 2026-11-06).
 *
 * ЛИЧНАЯ библиотека: «информация у каждого аккаунта видна только ему; разделы
 * и кнопки видны всем; исключение — Круг». Фильтр — `ownership()` из
 * `lib/auth/rbac.ts`: БЕЗ исключения для суперпользователя, ровно как у
 * документов. Суперпользователь администрирует аккаунты, но чужие промты не
 * видит — иначе согласие в Круге было бы декоративным.
 *
 * Промты раскладываются по проектам (раздел списка) и живут в двух состояниях:
 * живые (archived_at IS NULL) и архивные (archived_at проставлен). Архив — не
 * удаление: строка остаётся в таблице, потому что владелец просил сохранять
 * промты «на будущее — мало ли где пригодится, может быть, для обучения или
 * для какой-то истории». Удаление из архива — ручное действие из интерфейса.
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
 * Список промтов: живые или архивные, по разделам — только свои.
 *
 * Порядок — по проекту (без учёта регистра) и по убыванию времени создания:
 * внутри раздела свежие сверху, разделы идут в алфавитном порядке, чтобы их
 * не нужно было искать глазами.
 */
export async function listPrompts(
  user: SessionUser,
  options: { archived: boolean; project?: string },
): Promise<PromptItem[]> {
  const state = options.archived ? isNotNull(prompt.archivedAt) : isNull(prompt.archivedAt);
  const projectFilter = options.project ? eq(prompt.project, options.project) : undefined;
  const rows = await db
    .select()
    .from(prompt)
    .where(and(state, ownership(user, prompt.userId), projectFilter))
    .orderBy(asc(sql`lower(${prompt.project})`), desc(prompt.createdAt), desc(prompt.id));
  return rows.map(toItem);
}

/**
 * Сводка по разделам: сколько живых промтов в каждом проекте.
 *
 * Нужна странице, чтобы показать «сколько накопилось» рядом с разделом и
 * не дать владельцу искать нужный проект перебором.
 */
export async function summarizePromptProjects(user: SessionUser): Promise<PromptProjectSummary[]> {
  const rows = await db
    .select({
      project: prompt.project,
      count: sql<number>`count(*)::int`,
    })
    .from(prompt)
    .where(and(isNull(prompt.archivedAt), ownership(user, prompt.userId)))
    .groupBy(prompt.project)
    .orderBy(asc(sql`lower(${prompt.project})`));
  return rows.map((row) => ({ project: row.project, count: row.count }));
}

/**
 * Создаёт промт в библиотеке владельца.
 *
 * Тело нормализуется детерминированно (lib/prompts/normalize.ts): CRLF → LF,
 * висячие пробелы, лишние пустые строки. Смысл текста не трогается — этим
 * занимался Мозг до отправки.
 */
export async function createPrompt(
  user: SessionUser,
  input: { project: string; title?: string; body: string },
  source: PromptSource = 'manual',
): Promise<PromptItem> {
  const body = normalizePromptText(input.body);
  const title = input.title?.trim() ? input.title.trim() : derivePromptTitle(body);
  const [row] = await db
    .insert(prompt)
    .values({
      userId: user.id,
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
 * Живой аккаунт владельца — тот, кому принадлежит машинный канал промтов.
 *
 * Канал (`/api/prompts`) — это Мозг, который пишет по голосу владельца, а не
 * отдельный пользователь. Записываем от имени живого аккаунта владельца:
 * активного суперпользователя с наименьшим id. Если такого нет — канал не
 * работает (null), и вызывающий код отвечает 503: писать «от кого-то
 * третьего» нельзя.
 */
export async function resolveOwnerAccountId(): Promise<number | null> {
  const [row] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(and(eq(authUser.isSuperuser, true), eq(authUser.isActive, true)))
    .orderBy(asc(authUser.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Отправляет промт в архив или возвращает его в живые.
 *
 * Возвращает false, если такой строки уже нет (удалили в другой вкладке) —
 * вызывающий код покажет «не найдено», а не «ошибка». Чужой промт не
 * архивируется: `ownership()` в WHERE.
 */
export async function setPromptArchived(
  user: SessionUser,
  id: number,
  archived: boolean,
): Promise<boolean> {
  const [row] = await db
    .update(prompt)
    .set({ archivedAt: archived ? new Date().toISOString() : null })
    .where(and(eq(prompt.id, id), ownership(user, prompt.userId)))
    .returning({ id: prompt.id });
  return Boolean(row);
}

/** Удаляет промт насовсем (используется только для архивных). */
export async function deletePrompt(user: SessionUser, id: number): Promise<boolean> {
  const [row] = await db
    .delete(prompt)
    .where(and(eq(prompt.id, id), ownership(user, prompt.userId)))
    .returning({ id: prompt.id });
  return Boolean(row);
}

/**
 * Очистка архива: удаляет МОИ архивные промты (все или старше даты).
 *
 * Ни живых, ни чужих не трогает никогда: чистится только то, что владелец
 * сам отправил в архив. Число удалённых возвращается наружу, чтобы интерфейс
 * показал, сколько именно убрано.
 */
export async function purgeArchivedPrompts(user: SessionUser, before?: string): Promise<number> {
  const conditions = [isNotNull(prompt.archivedAt), ownership(user, prompt.userId)];
  if (before) {
    conditions.push(lt(prompt.archivedAt, `${before} 00:00:00+00`));
  }
  const rows = await db
    .delete(prompt)
    .where(and(...conditions))
    .returning({ id: prompt.id });
  return rows.length;
}

/** Сколько строк в моём архиве — показывается рядом с кнопкой «Очистить архив». */
export async function countArchivedPrompts(user: SessionUser): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(prompt)
    .where(and(isNotNull(prompt.archivedAt), ownership(user, prompt.userId)));
  return row?.count ?? 0;
}
