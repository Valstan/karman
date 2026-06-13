import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { reminder, reminderSchedule } from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import { computeNextFire } from '@/lib/reminders/schedule';
import type { ScheduleEnd, ScheduleSpec } from '@/lib/reminders/types';
import type { ReminderCreateInput, ReminderUpdateInput } from '@/lib/validation/reminder';

export type ReminderListItem = {
  id: number;
  title: string;
  body: string;
  priority: 'normal' | 'high';
  silent: boolean;
  status: 'active' | 'paused' | 'done' | 'archived';
  /** Полная спека расписания — UI выводит человекочитаемо и префиллит форму. */
  spec: ScheduleSpec | null;
  nextFireAt: string | null;
  lastFiredAt: string | null;
};

function buildEnd(input: ReminderCreateInput): ScheduleEnd | undefined {
  if (input.endType === 'afterN' && input.endN) {
    return { type: 'afterN', n: input.endN };
  }
  if (input.endType === 'until' && input.endUntil) {
    return { type: 'until', until: input.endUntil };
  }
  return undefined; // never
}

function buildSpec(input: ReminderCreateInput): ScheduleSpec {
  const end = buildEnd(input);
  if (input.repeat === 'none') {
    return { kind: 'oneoff', at: input.at, ...(end ? { end } : {}) };
  }
  const startDate = input.at.slice(0, 10);
  const time = input.at.slice(11, 16);
  return {
    kind: 'recurring',
    freq: input.repeat,
    interval: input.interval,
    startDate,
    time,
    ...(input.repeat === 'weekly' && input.weekdays.length ? { weekdays: input.weekdays } : {}),
    ...(input.repeat === 'monthly' && input.monthday !== undefined ? { monthday: input.monthday } : {}),
    ...(end ? { end } : {}),
  };
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
    spec: r.spec,
    nextFireAt: r.nextFireAt,
    lastFiredAt: r.lastFiredAt,
  }));
}

export async function createReminder(user: SessionUser, input: ReminderCreateInput): Promise<number> {
  const spec = buildSpec(input);
  const nextFireAt = computeNextFire(spec, new Date().toISOString(), 0);
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

    await tx.insert(reminderSchedule).values({ reminderId: created!.id, spec, nextFireAt });
    return created!.id;
  });
}

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
  const spec = buildSpec(input);
  const nextFireAt = computeNextFire(spec, new Date().toISOString(), 0);

  await db.transaction(async (tx) => {
    await tx
      .update(reminder)
      .set({
        title: input.title,
        bodyTemplate: input.body ?? '',
        priority: input.priority,
        silent: input.silent ?? false,
        status: 'active', // повторное сохранение возвращает в активное
      })
      .where(eq(reminder.id, id));
    await tx
      .update(reminderSchedule)
      .set({ spec, nextFireAt, fireCount: 0, lastFiredAt: null })
      .where(eq(reminderSchedule.reminderId, id));
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
