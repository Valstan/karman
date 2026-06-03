'use server';

import { creditCreateSchema, creditUpdateSchema } from '@/lib/validation/credit';
import {
  createCredit,
  updateCredit,
  deleteCredit,
  regenerateSchedule,
} from '@/lib/services/credits';
import { currentUserOrNull, revalidateAll, type ActionResult } from './_internal';

export async function createCreditAction(values: unknown): Promise<ActionResult<{ id: number }>> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };

  const parsed = creditCreateSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }

  const id = await createCredit(user, parsed.data);
  revalidateAll();
  return { ok: true, data: { id } };
}

export async function updateCreditAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };

  const parsed = creditUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }

  const updated = await updateCredit(user, parsed.data);
  if (!updated) return { ok: false, error: 'Кредит не найден' };
  revalidateAll();
  return { ok: true };
}

export async function deleteCreditAction(id: number): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };

  const deleted = await deleteCredit(user, id);
  if (!deleted) return { ok: false, error: 'Кредит не найден' };
  revalidateAll();
  return { ok: true };
}

export async function regenerateScheduleAction(id: number): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };

  const done = await regenerateSchedule(user, id);
  if (!done) return { ok: false, error: 'Кредит не найден' };
  revalidateAll();
  return { ok: true };
}
