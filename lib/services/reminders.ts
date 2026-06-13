import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { reminder, reminderSchedule } from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import { moscowLocalToUtcIso } from '@/lib/reminders/time';
import type { ScheduleSpec } from '@/lib/reminders/types';
import type { ReminderCreateInput, ReminderUpdateInput } from '@/lib/validation/reminder';

export type ReminderListItem = {
  id: number;
  title: string;
  body: string;
  priority: 'normal' | 'high';
  silent: boolean;
  status: 'active' | 'paused' | 'done' | 'archived';
  /** Московский wall-clock 'YYYY-MM-DDTHH:MM' разового напоминания (для формы). */
  at: string | null;
  /** UTC-инстант ближайшего срабатывания (ISO) или null. */
  nextFireAt: string | null;
  lastFiredAt: string | null;
};

function oneoffSpec(at: string): ScheduleSpec {
  return { kind: 'oneoff', at, tz: 'Europe/Moscow' };
}

export async function listReminders(user: SessionUser): Promise<ReminderListItem[]> {
  const rows = await db
    .select({
      id: reminder.id,
      title: reminder.title,
      body: reminder.bodyTemplate,
      priority: reminder.priority,
      silent: reminder.silent,
      status: reminder.status,
      spec: reminderSchedule.spec,
      nextFireAt: reminderSchedule.nextFireAt,
      lastFiredAt: reminderSchedule.lastFiredAt,
    })
    .from(reminder)
    .leftJoin(reminderSchedule, eq(reminderSchedule.reminderId, reminder.id))
    .where(ownership(user, reminder.userId))
    .orderBy(desc(reminder.id));

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    priority: r.priority,
    silent: r.silent,
    status: r.status,
    at: r.spec?.kind === 'oneoff' ? r.spec.at : null,
    nextFireAt: r.nextFireAt,
    lastFiredAt: r.lastFiredAt,
  }));
}

export async function createReminder(user: SessionUser, input: ReminderCreateInput): Promise<number> {
  const nextFireAt = moscowLocalToUtcIso(input.at);
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(reminder)
      .values({
        userId: user.id,
        title: input.title,
        bodyTemplate: input.body ?? '',
        sourceType: 'freeform',
        priority: input.priority,
        silent: input.silent ?? false,
        status: 'active',
      })
      .returning({ id: reminder.id });

    await tx
      .insert(reminderSchedule)
      .values({ reminderId: created!.id, spec: oneoffSpec(input.at), nextFireAt });

    return created!.id;
  });
}

/** Проверяет владение и возвращает id, если напоминание доступно пользователю. */
async function ownedReminderId(user: SessionUser, id: number): Promise<number | null> {
  const [row] = await db
    .select({ id: reminder.id })
    .from(reminder)
    .where(and(eq(reminder.id, id), ownership(user, reminder.userId)))
    .limit(1);
  return row?.id ?? null;
}

export async function updateReminder(user: SessionUser, input: ReminderUpdateInput): Promise<boolean> {
  const id = await ownedReminderId(user, input.id);
  if (id === null) {
    return false;
  }

  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.body !== undefined) patch.bodyTemplate = input.body ?? '';
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.silent !== undefined) patch.silent = input.silent;

  await db.transaction(async (tx) => {
    if (Object.keys(patch).length > 0) {
      await tx.update(reminder).set(patch).where(eq(reminder.id, id));
    }
    if (input.at !== undefined) {
      // Перепланирование разового: пересчитываем next_fire_at и сбрасываем счётчик.
      await tx
        .update(reminderSchedule)
        .set({
          spec: oneoffSpec(input.at),
          nextFireAt: moscowLocalToUtcIso(input.at),
          fireCount: 0,
          lastFiredAt: null,
        })
        .where(eq(reminderSchedule.reminderId, id));
    }
  });
  return true;
}

export async function deleteReminder(user: SessionUser, id: number): Promise<boolean> {
  const result = await db
    .delete(reminder)
    .where(and(eq(reminder.id, id), ownership(user, reminder.userId)))
    .returning({ id: reminder.id });
  return result.length > 0;
}

export async function setReminderStatus(
  user: SessionUser,
  id: number,
  status: 'active' | 'paused',
): Promise<boolean> {
  const result = await db
    .update(reminder)
    .set({ status })
    .where(and(eq(reminder.id, id), ownership(user, reminder.userId)))
    .returning({ id: reminder.id });
  return result.length > 0;
}
