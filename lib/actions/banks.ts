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

/**
 * Правка и удаление записи справочника — только владелец (решение владельца
 * 2026-09-03: «добавлять могут все, удалять не могут»). Правка ограничена по
 * той же причине, что и удаление: переименование чужой записи общего справочника
 * ломает её ровно так же, только тише — кредиты остаются привязаны к строке,
 * которая теперь называется иначе.
 */
export async function updateBankAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  if (!user.isSuperuser) {
    return { ok: false, error: 'Справочник банков общий: править записи может только владелец' };
  }

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
  if (!user.isSuperuser) {
    return { ok: false, error: 'Справочник банков общий: удалять записи может только владелец' };
  }

  const result = await deleteBank(id);
  if (result === 'in_use') {
    // Счётчик «в работе» здесь по ВСЕМ пользователям, и это правильно: удалять
    // нельзя, пока запись нужна хоть кому-то. Число наружу не отдаётся — только
    // сам факт, иначе владелец узнавал бы объём чужих займов через отказ.
    return { ok: false, error: 'Нельзя удалить банк: к нему привязаны кредиты' };
  }
  if (result === 'not_found') {
    return { ok: false, error: 'Банк не найден' };
  }
  revalidateAll();
  return { ok: true };
}
