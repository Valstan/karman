import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { reminder, reminderAction, reminderDelivery, reminderSchedule, telegramLink } from '@/lib/db/schema';
import { addHoursIso, moscowNextDayAtIso } from '@/lib/reminders/time';
import type { CallbackParsed } from '@/lib/reminders/callback';

export type CallbackOutcome = { answer: string; clearKeyboard: boolean };

/**
 * Применяет нажатие кнопки: RBAC (chat → привязка → владелец напоминания) +
 * идемпотентность (UNIQUE delivery_id, action) + действие через ту же БД, что и веб.
 */
export async function applyReminderCallback(
  parsed: CallbackParsed,
  chatId: number,
  callbackId: string,
): Promise<CallbackOutcome> {
  const [link] = await db
    .select({ userId: telegramLink.userId, isActive: telegramLink.isActive })
    .from(telegramLink)
    .where(eq(telegramLink.chatId, chatId))
    .limit(1);
  if (!link || !link.isActive) {
    return { answer: 'Аккаунт не привязан', clearKeyboard: false };
  }

  const [row] = await db
    .select({
      reminderId: reminderDelivery.reminderId,
      scheduleId: reminderDelivery.scheduleId,
      ownerId: reminder.userId,
    })
    .from(reminderDelivery)
    .innerJoin(reminder, eq(reminder.id, reminderDelivery.reminderId))
    .where(eq(reminderDelivery.id, parsed.deliveryId))
    .limit(1);
  if (!row || row.ownerId !== link.userId) {
    return { answer: 'Нет доступа', clearKeyboard: false };
  }

  const storedAction = parsed.action === 'snz' ? 'snooze' : parsed.action;
  const claimed = await db
    .insert(reminderAction)
    .values({
      deliveryId: parsed.deliveryId,
      reminderId: row.reminderId,
      userId: link.userId,
      action: storedAction,
      payload: parsed.arg ? { arg: parsed.arg } : null,
      tgCallbackId: callbackId,
    })
    .onConflictDoNothing({ target: [reminderAction.deliveryId, reminderAction.action] })
    .returning({ id: reminderAction.id });
  if (claimed.length === 0) {
    return { answer: 'Уже выполнено', clearKeyboard: true };
  }

  if (parsed.action === 'done' || parsed.action === 'ack') {
    await db.update(reminder).set({ status: 'done' }).where(eq(reminder.id, row.reminderId));
    if (row.scheduleId !== null) {
      await db.update(reminderSchedule).set({ nextFireAt: null }).where(eq(reminderSchedule.id, row.scheduleId));
    }
    return { answer: 'Готово ✓', clearKeyboard: true };
  }

  // snooze
  const now = new Date().toISOString();
  const next = parsed.arg === 'tmrw' ? moscowNextDayAtIso(now, '09:00') : addHoursIso(now, 1);
  if (row.scheduleId !== null) {
    await db.update(reminderSchedule).set({ nextFireAt: next }).where(eq(reminderSchedule.id, row.scheduleId));
  }
  await db.update(reminder).set({ status: 'active' }).where(eq(reminder.id, row.reminderId));
  return { answer: parsed.arg === 'tmrw' ? 'Отложено до завтра 09:00' : 'Отложено на 1 час', clearKeyboard: true };
}
