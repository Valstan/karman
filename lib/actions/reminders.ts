'use server';

import { reminderCreateSchema, reminderUpdateSchema } from '@/lib/validation/reminder';
import {
  createReminder,
  deleteReminder,
  setReminderStatus,
  updateReminder,
} from '@/lib/services/reminders';
import { currentUserOrNull, revalidateAll, type ActionResult } from './_internal';

export async function createReminderAction(values: unknown): Promise<ActionResult<{ id: number }>> {
  const user = await currentUserOrNull();
  if (!user) {
    return { ok: false, error: 'Требуется авторизация' };
  }
  const parsed = reminderCreateSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  const id = await createReminder(user, parsed.data);
  revalidateAll();
  return { ok: true, data: { id } };
}

export async function updateReminderAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) {
    return { ok: false, error: 'Требуется авторизация' };
  }
  const parsed = reminderUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  const updated = await updateReminder(user, parsed.data);
  if (!updated) {
    return { ok: false, error: 'Напоминание не найдено' };
  }
  revalidateAll();
  return { ok: true };
}

export async function deleteReminderAction(id: number): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) {
    return { ok: false, error: 'Требуется авторизация' };
  }
  const deleted = await deleteReminder(user, id);
  if (!deleted) {
    return { ok: false, error: 'Напоминание не найдено' };
  }
  revalidateAll();
  return { ok: true };
}

export async function setReminderStatusAction(
  id: number,
  status: 'active' | 'paused',
): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) {
    return { ok: false, error: 'Требуется авторизация' };
  }
  const changed = await setReminderStatus(user, id, status);
  if (!changed) {
    return { ok: false, error: 'Напоминание не найдено' };
  }
  revalidateAll();
  return { ok: true };
}
