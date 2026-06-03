'use server';

import { paymentCreateSchema, paymentUpdateSchema } from '@/lib/validation/payment';
import { createPayment, updatePayment, deletePayment } from '@/lib/services/payments';
import { currentUserOrNull, revalidateAll, type ActionResult } from './_internal';

export async function createPaymentAction(values: unknown): Promise<ActionResult<{ id: number }>> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };

  const parsed = paymentCreateSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }

  const id = await createPayment(user, parsed.data);
  if (id === null) return { ok: false, error: 'Кредит не найден' };
  revalidateAll();
  return { ok: true, data: { id } };
}

export async function updatePaymentAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };

  const parsed = paymentUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }

  const updated = await updatePayment(user, parsed.data);
  if (!updated) return { ok: false, error: 'Платёж не найден' };
  revalidateAll();
  return { ok: true };
}

export async function deletePaymentAction(id: number): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };

  const deleted = await deletePayment(user, id);
  if (!deleted) return { ok: false, error: 'Платёж не найден' };
  revalidateAll();
  return { ok: true };
}
