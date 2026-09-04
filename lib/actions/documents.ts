'use server';

import {
  documentCreateSchema,
  documentFieldsSchema,
  documentUpdateSchema,
} from '@/lib/validation/document';
import {
  createDocument,
  updateDocument,
  deleteDocument,
  replaceDocumentFields,
  setCircleShared,
} from '@/lib/services/documents';
import { currentUserOrNull, revalidateAll, type ActionResult } from './_internal';

/**
 * Заменяет набор произвольных полей документа целиком. Строки с пустым
 * названием выбрасываются здесь, а не отвергаются валидатором: человек добавил
 * строку, не заполнил и нажал «Сохранить» — терять из-за этого весь остальной
 * ввод было бы наказанием за пустую строку.
 */
export async function saveDocumentFieldsAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };

  const parsed = documentFieldsSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }

  const fields = parsed.data.fields.filter((f) => f.name !== '');
  const saved = await replaceDocumentFields(user, parsed.data.id, fields);
  if (!saved) return { ok: false, error: 'Документ не найден' };
  revalidateAll();
  return { ok: true };
}

export async function createDocumentAction(values: unknown): Promise<ActionResult<{ id: number }>> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };

  const parsed = documentCreateSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }

  const id = await createDocument(user, parsed.data);
  revalidateAll();
  return { ok: true, data: { id } };
}

export async function updateDocumentAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };

  const parsed = documentUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }

  const updated = await updateDocument(user, parsed.data);
  if (!updated) return { ok: false, error: 'Документ не найден' };
  revalidateAll();
  return { ok: true };
}

/**
 * Открыть кругу / забрать из круга — списком id (галочки в разделе «Документы»).
 * Владение проверяет сервис: чужие id просто не считаются.
 */
export async function setCircleSharedAction(
  ids: number[],
  shared: boolean,
): Promise<ActionResult<{ count: number }>> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const clean = ids.filter((id) => Number.isInteger(id) && id > 0).slice(0, 500);
  const count = await setCircleShared(user, clean, shared);
  revalidateAll();
  return { ok: true, data: { count } };
}

export async function deleteDocumentAction(id: number): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };

  const deleted = await deleteDocument(user, id);
  if (!deleted) return { ok: false, error: 'Документ не найден' };
  revalidateAll();
  return { ok: true };
}
