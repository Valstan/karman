import 'server-only';

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { authUser, prompt, promptPart, promptProject } from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import { derivePromptTitle, normalizePromptText } from '@/lib/prompts/normalize';
import {
  citedIds,
  citedPlanIds,
  isPlanTitle,
  mergePromptBodies,
  quotedPromptId,
  titleOverlapWords,
} from '@/lib/prompts/pairing';
import type {
  PromptItem,
  PromptProjectSummary,
  PromptSection,
  PromptSource,
} from '@/lib/prompts/types';

export type {
  PromptItem,
  PromptProjectSummary,
  PromptSection,
  PromptSource,
} from '@/lib/prompts/types';

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
 * Устаревшая форма: считала по промтам, а не по реестру разделов, поэтому
 * заранее заведённый пустой раздел в неё не попадал. Осталась для сценариев,
 * где нужен именно счётчик по промтам.
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
 * Разделы библиотеки: реестр разделов + счётчик промтов в указанном состоянии.
 *
 * Источник списка — реестр (`prompt_project`), а не «разные значения project среди
 * промтов»: пустой раздел должен существовать и быть виден, чтобы все разделы
 * экосистемы можно было завести заранее (заказ владельца 2026-11-06).
 *
 * Условие состояния — в ON джойна, а не в WHERE: в WHERE оно превратило бы
 * LEFT JOIN в INNER и выкинуло бы разделы без промтов в этом состоянии — то
 * есть ровно те, которые заведены заранее.
 */
export async function listPromptSections(
  user: SessionUser,
  options: { archived: boolean },
): Promise<PromptSection[]> {
  const state = options.archived ? isNotNull(prompt.archivedAt) : isNull(prompt.archivedAt);
  const rows = await db
    .select({
      name: promptProject.name,
      count: sql<number>`count(${prompt.id})::int`,
    })
    .from(promptProject)
    .leftJoin(
      prompt,
      and(
        eq(prompt.userId, promptProject.userId),
        eq(prompt.project, promptProject.name),
        state,
      ),
    )
    .where(ownership(user, promptProject.userId))
    .groupBy(promptProject.name)
    .orderBy(asc(sql`lower(${promptProject.name})`));
  return rows.map((row) => ({ name: row.name, count: row.count }));
}

/**
 * Завести раздел, если его ещё нет (идемпотентно).
 *
 * Вызывается при записи промта: раздел появляется сам, даже если его не было в
 * реестре (например, первый промт приехал раньше, чем приехал канон).
 */
export async function ensurePromptProject(user: SessionUser, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean || clean.length > 64) return;
  await db
    .insert(promptProject)
    .values({ userId: user.id, name: clean })
    .onConflictDoNothing();
}

/**
 * Синхронизировать список разделов с каноном экосистемы (машинный канал Мозга).
 *
 * Только ДОБАВЛЕНИЕ: чужие разделы не трогаются и не пропадают — канон может
 * прийти неполным, и стирать то, что завёл человек, нельзя. Переименование —
 * отдельной операцией (`renamePromptProject`).
 */
export async function syncPromptProjects(user: SessionUser, names: string[]): Promise<number> {
  const clean = [
    ...new Set(
      names
        .map((name) => name.trim())
        .filter((name) => name.length > 0 && name.length <= 64),
    ),
  ];
  if (clean.length === 0) return 0;
  const rows = await db
    .insert(promptProject)
    .values(clean.map((name) => ({ userId: user.id, name })))
    .onConflictDoNothing()
    .returning({ id: promptProject.id });
  return rows.length;
}

/**
 * Переименовать раздел — и сам раздел, и его промты.
 *
 * Если раздел с новым именем уже есть, раздел сливается с ним: промты
 * переезжают, старый раздел исчезает. Иначе переименовывается на месте.
 */
export async function renamePromptProject(
  user: SessionUser,
  from: string,
  to: string,
): Promise<boolean> {
  const target = to.trim();
  if (!target || target.length > 64 || target === from) return false;
  const [section] = await db
    .select({ id: promptProject.id })
    .from(promptProject)
    .where(and(eq(promptProject.userId, user.id), eq(promptProject.name, from)))
    .limit(1);
  if (!section) return false;

  const [existing] = await db
    .select({ id: promptProject.id })
    .from(promptProject)
    .where(and(eq(promptProject.userId, user.id), eq(promptProject.name, target)))
    .limit(1);

  await db
    .update(prompt)
    .set({ project: target })
    .where(and(eq(prompt.userId, user.id), eq(prompt.project, from)));

  if (existing) {
    // Слияние: целевой раздел уже есть — старый убираем, промты живут в целевом.
    await db
      .delete(promptProject)
      .where(and(eq(promptProject.userId, user.id), eq(promptProject.name, from)));
  } else {
    await db
      .update(promptProject)
      .set({ name: target })
      .where(and(eq(promptProject.userId, user.id), eq(promptProject.name, from)));
  }
  return true;
}

/**
 * Создаёт промт в библиотеке владельца.
 *
 * Тело нормализуется детерминированно (lib/prompts/normalize.ts): CRLF → LF,
 * висячие пробелы, лишние пустые строки. Смысл текста не трогается — этим
 * занимался Мозг до отправки.
 *
 * ПАРА «НАЧИТКА + ПЛАН» (заказ владельца 24.11): задача лежит одним промтом —
 * тело начитки, пустая строка, тело плана. Поэтому машинный канал (Мозг)
 * присылает план отдельной записью, а хранилище присоединяет его к начитке;
 * вторая строка не появляется. Продолжение задачи («Ответы владельца по плану
 * id 65») присоединяется туда же. Явная привязка — `partOf`: id промта, к
 * которому присоединить текст.
 *
 * Если начитку найти не удалось — план остаётся отдельной записью: молча
 * приклеить план чужой задачи хуже, чем показать владельцу лишнюю запись.
 */
export async function createPrompt(
  user: SessionUser,
  input: { project: string; title?: string; body: string; partOf?: number },
  source: PromptSource = 'manual',
): Promise<CreatedPrompt> {
  const body = normalizePromptText(input.body);
  const title = input.title?.trim() ? input.title.trim() : derivePromptTitle(body);
  const project = input.project.trim();
  await ensurePromptProject(user, project);

  if (source === 'brain') {
    const target = await resolveMergeTarget(user, project, title, body, input.partOf);
    if (target) {
      return mergeIntoPrompt(user, project, title, body, source, target.id);
    }
  }

  const [row] = await db
    .insert(prompt)
    .values({
      userId: user.id,
      project,
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

/** Промт с признаком «влит в другой промт». */
export type CreatedPrompt = PromptItem & { merged?: boolean; partId?: number };

/**
 * Окно, в котором начитка ещё считается свежей для подбора пары.
 *
 * План Мозг присылает сразу после начитки; если начитка старше — это уже
 * другая задача, и приклеивать к ней план нельзя.
 */
const PAIRING_WINDOW_MS = 3 * 60 * 60 * 1000;

/** Минимум общих слов в заголовках, чтобы считать начитку своей. */
const TITLE_OVERLAP_MIN = 2;

/**
 * К кому присоединить текст: план — к своей начитке, продолжение — к задаче,
 * чей план оно цитирует.
 *
 * Порядок признаков — от точного к осторожному:
 *   1. явная привязка `partOf`;
 *   2. ссылка на запись: id плана (уже влитого) → промт-владелец; id начитки → она;
 *   3. дословная цитата начитки в теле плана;
 *   4. заголовки: самая близкая по общим словам (в окне свежести).
 */
async function resolveMergeTarget(
  user: SessionUser,
  project: string,
  title: string,
  body: string,
  explicitId?: number,
): Promise<{ id: number } | null> {
  if (explicitId) {
    const [row] = await db
      .select({ id: prompt.id })
      .from(prompt)
      .where(and(eq(prompt.id, explicitId), eq(prompt.userId, user.id), eq(prompt.project, project)))
      .limit(1);
    if (row) return row;
  }

  const ids = citedIds(body);
  const planIds = citedPlanIds(body);

  if (ids.length > 0) {
    // План, уже влитый в промт: продолжение задачи — идём в тот же промт.
    const [merged] = await db
      .select({ promptId: promptPart.promptId })
      .from(promptPart)
      .where(inArray(promptPart.partId, ids))
      .limit(1);
    if (merged) return { id: merged.promptId };

    // Прямая ссылка на начитку (а не на план) — присоединяем к ней.
    const cited = await db
      .select({ id: prompt.id, title: prompt.title })
      .from(prompt)
      .where(and(inArray(prompt.id, ids), eq(prompt.userId, user.id), eq(prompt.project, project)));
    for (const row of cited) {
      if (!isPlanTitle(row.title)) return { id: row.id };
    }
  }

  // Продолжение задачи: «Ответы владельца по плану id 65».
  if (planIds.length > 0) {
    const [merged] = await db
      .select({ promptId: promptPart.promptId })
      .from(promptPart)
      .where(inArray(promptPart.partId, planIds))
      .limit(1);
    if (merged) return { id: merged.promptId };
  }

  const candidates = await freshUnmergedPrompts(user, project);
  if (candidates.length === 0) return null;

  const quoted = quotedPromptId(body, candidates);
  if (quoted) return { id: quoted };

  let best: { id: number } | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = titleOverlapWords(title, candidate.title);
    if (score > bestScore) {
      best = { id: candidate.id };
      bestScore = score;
    }
  }
  return bestScore >= TITLE_OVERLAP_MIN ? best : null;
}

/**
 * Начитки проекта, у которых ещё нет плана, — живые и свежие.
 *
 * «Нет плана» проверяется по таблице слияний, а не по тексту: правило хранения
 * должно быть проверяемым (иначе одна опечатка в заголовке разъезжает пары).
 */
async function freshUnmergedPrompts(
  user: SessionUser,
  project: string,
): Promise<{ id: number; title: string; body: string }[]> {
  const since = new Date(Date.now() - PAIRING_WINDOW_MS).toISOString();
  const rows = await db
    .select({ id: prompt.id, title: prompt.title, body: prompt.body })
    .from(prompt)
    .where(
      and(
        eq(prompt.userId, user.id),
        eq(prompt.project, project),
        isNull(prompt.archivedAt),
        gte(prompt.createdAt, since),
      ),
    )
    .orderBy(asc(prompt.createdAt));
  const merged = await db.select({ promptId: promptPart.promptId }).from(promptPart);
  const busy = new Set(merged.map((row) => row.promptId));
  return rows.filter((row) => !busy.has(row.id) && !isPlanTitle(row.title));
}

/**
 * Влить текст в чужой промт: запись-план создаётся и сразу уходит, а её текст
 * встаёт в тело промта-начитки. Всё одной транзакцией: полуслитая пара видна
 * владельцу как полуслитая.
 */
async function mergeIntoPrompt(
  user: SessionUser,
  project: string,
  title: string,
  body: string,
  source: PromptSource,
  targetId: number,
): Promise<CreatedPrompt> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(prompt)
      .where(and(eq(prompt.id, targetId), eq(prompt.userId, user.id)))
      .limit(1);
    if (!target) throw new Error('промт-начитка не найден');

    const [part] = await tx
      .insert(prompt)
      .values({ userId: user.id, project, title, body, source })
      .returning();
    if (!part) throw new Error('промт не записался');

    await tx.insert(promptPart).values({ partId: part.id, promptId: target.id });

    const mergedBody = mergePromptBodies(target.body, body);
    await tx.update(prompt).set({ body: mergedBody }).where(eq(prompt.id, target.id));
    await tx.delete(prompt).where(eq(prompt.id, part.id));

    return { ...toItem(target), body: mergedBody, merged: true, partId: part.id };
  });
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

/**
 * Промты РАЗДЕЛА — без фильтра по владельцу.
 *
 * Обычная библиотека личная (`ownership()` — «информация у каждого аккаунта
 * видна только ему»), но машинный канал проекта устроен иначе: право на
 * раздел даёт ТОКЕН раздела, а не сессия. Промты в разделе принадлежат
 * владельцу аккаунта (пишет Мозг от его имени) — значит, фильтр по владельцу
 * здесь был бы не защитой, а запретом: проект не увидел бы СВОИ промты.
 * Защита здесь — другой раздел: `section` закреплён токеном (см.
 * `lib/prompts/section-auth.ts`).
 *
 * Порядок — свежие сверху: проект забирает «новые, не в архиве».
 */
export async function listSectionPrompts(
  section: string,
  options: { archived: boolean },
): Promise<PromptItem[]> {
  const state = options.archived ? isNotNull(prompt.archivedAt) : isNull(prompt.archivedAt);
  const rows = await db
    .select()
    .from(prompt)
    .where(and(state, eq(prompt.project, section)))
    .orderBy(desc(prompt.createdAt), desc(prompt.id));
  return rows.map(toItem);
}

/**
 * Архивирование промта РАЗДЕЛА: только свой раздел, только по id.
 *
 * Архив — не удаление: строка остаётся с датой архивации, вернуть можно
 * (`archived: false`). Промт чужого раздела не архивируется — условие по
 * `project` в WHERE, а не проверка после выборки.
 */
export async function setPromptArchivedInSection(
  section: string,
  id: number,
  archived: boolean,
): Promise<boolean> {
  const [row] = await db
    .update(prompt)
    .set({ archivedAt: archived ? new Date().toISOString() : null })
    .where(and(eq(prompt.id, id), eq(prompt.project, section)))
    .returning({ id: prompt.id });
  return Boolean(row);
}
