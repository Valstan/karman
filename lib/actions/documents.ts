'use server';

import { documentCreateSchema, documentUpdateSchema } from '@/lib/validation/document';
import { createDocument, updateDocument, deleteDocument } from '@/lib/services/documents';
import { currentUserOrNull, revalidateAll, type ActionResult } from './_internal';

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

export async function deleteDocumentAction(id: number): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };

  const deleted = await deleteDocument(user, id);
  if (!deleted) return { ok: false, error: 'Документ не найден' };
  revalidateAll();
  return { ok: true };
}
