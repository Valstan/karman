'use server';

import { revalidatePath } from 'next/cache';
import { currentUserOrNull, type ActionResult } from '@/lib/actions/_internal';
import { promptCreateSchema, promptIdSchema, promptPurgeSchema } from '@/lib/validation/prompt';
import {
  createPrompt,
  deletePrompt,
  purgeArchivedPrompts,
  setPromptArchived,
} from '@/lib/services/prompts';

/**
 * Промты (заказ владельца 2026-11-06).
 *
 * Библиотека ЛИЧНАЯ: «информация у каждого аккаунта видна только ему; разделы
 * и кнопки видны всем; исключение — Круг». Поэтому здесь нет гейта
 * «только суперпользователь»: каждый вошедший управляет СВОИМИ промтами, а
 * чужое закрыто `ownership()` внутри сервиса. Исключение для суперпользователя
 * здесь означало бы, что «моё видно всем» — а это ровно то, что запрещено.
 *
 * Гейт сессии стоит в первых строках каждого действия: Server Action зовут
 * POST'ом по собственному идентификатору из чужого браузера, поэтому проверка
 * обязана быть в самом действии, а не на странице (см. docs/write-paths.md).
 */

export async function createPromptAction(values: unknown): Promise<ActionResult<{ id: number }>> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = promptCreateSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  const created = await createPrompt(user, parsed.data, 'manual');
  revalidatePath('/map');
  return { ok: true, data: { id: created.id } };
}

export async function archivePromptAction(id: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsedId = promptIdSchema.safeParse(id);
  if (!parsedId.success) return { ok: false, error: 'Некорректный id промта' };
  const done = await setPromptArchived(user, parsedId.data, true);
  if (!done) return { ok: false, error: 'Промт не найден' };
  revalidatePath('/map');
  return { ok: true };
}

export async function restorePromptAction(id: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsedId = promptIdSchema.safeParse(id);
  if (!parsedId.success) return { ok: false, error: 'Некорректный id промта' };
  const done = await setPromptArchived(user, parsedId.data, false);
  if (!done) return { ok: false, error: 'Промт не найден' };
  revalidatePath('/map');
  return { ok: true };
}

export async function deletePromptAction(id: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsedId = promptIdSchema.safeParse(id);
  if (!parsedId.success) return { ok: false, error: 'Некорректный id промта' };
  const done = await deletePrompt(user, parsedId.data);
  if (!done) return { ok: false, error: 'Промт не найден' };
  revalidatePath('/map');
  return { ok: true };
}

/**
 * Очистка архива: удаляет МОИ архивные промты — все или старше указанной даты.
 *
 * Живые промты не трогает никогда: чистится только то, что владелец сам
 * отправил в архив. Число удалённых возвращается наружу, чтобы интерфейс
 * показал, сколько именно убрано.
 */
export async function purgeArchivedPromptsAction(values: unknown): Promise<ActionResult<{ removed: number }>> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = promptPurgeSchema.safeParse(values ?? {});
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  const removed = await purgeArchivedPrompts(user, parsed.data.before);
  revalidatePath('/map');
  return { ok: true, data: { removed } };
}
