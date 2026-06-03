'use server';

import { bankCreateSchema, bankUpdateSchema } from '@/lib/validation/bank';
import { createBank, updateBank, deleteBank } from '@/lib/services/banks';
import { currentUserOrNull, revalidateAll, type ActionResult } from './_internal';

export async function createBankAction(values: unknown): Promise<ActionResult<{ id: number }>> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };

  const parsed = bankCreateSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }

  const id = await createBank(parsed.data);
  revalidateAll();
  return { ok: true, data: { id } };
}

export async function updateBankAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };

  const parsed = bankUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }

  const updated = await updateBank(parsed.data);
  if (!updated) return { ok: false, error: 'Банк не найден' };
  revalidateAll();
  return { ok: true };
}

export async function deleteBankAction(id: number): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };

  const result = await deleteBank(id);
  if (result === 'in_use') {
    return { ok: false, error: 'Нельзя удалить банк: к нему привязаны кредиты' };
  }
  if (result === 'not_found') {
    return { ok: false, error: 'Банк не найден' };
  }
  revalidateAll();
  return { ok: true };
}
