import 'server-only';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  creditsCredit,
  creditsPayment,
  documentsDocument,
  reminder,
  reminderSchedule,
} from '@/lib/db/schema';
import { computeNextFire } from '@/lib/reminders/schedule';
import { utcToMoscowLocal } from '@/lib/reminders/time';
import {
  AUTO_TIME,
  DOC_EXPIRY_OFFSETS,
  PAYMENT_DUE_OFFSETS,
  RULE_DOC_EXPIRY,
  RULE_PAYMENT_DUE,
  RULE_PAYMENT_OVERDUE,
  TPL,
} from '@/lib/reminders/domain-templates';
import type { ReminderSourceType } from '@/lib/reminders/types';
import type { ScheduleSpec } from '@/lib/reminders/types';

/** 'YYYY-MM-DD' + delta дней → 'YYYY-MM-DD' (UTC-арифметика дат). */
function shiftDate(dateStr: string, deltaDays: number): string {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7));
  const d = Number(dateStr.slice(8, 10));
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

function datesSpec(anchorDate: string, offsets: number[]): ScheduleSpec {
  const dates = offsets.map((o) => shiftDate(anchorDate, -o)).sort();
  return { kind: 'dates', dates, times: [AUTO_TIME] };
}

type SyncItem = { userId: number; sourceId: number; spec: ScheduleSpec };

/**
 * Приводит авто-напоминания одного правила в соответствие источникам: создаёт
 * недостающие, удаляет осиротевшие (источник больше не подходит), переназначает
 * расписание ТОЛЬКО при изменении спеки (чтобы не сбрасывать прогресс/не перепосылать).
 */
async function syncRule(
  ruleId: string,
  sourceType: ReminderSourceType,
  title: string,
  body: string,
  items: SyncItem[],
): Promise<void> {
  const keep = items.map((i) => i.sourceId);
  await db.delete(reminder).where(
    and(
      eq(reminder.sourceType, sourceType),
      eq(reminder.ruleId, ruleId),
      keep.length ? notInArray(reminder.sourceId, keep) : sql`true`,
    ),
  );

  const now = new Date().toISOString();
  for (const it of items) {
    const [existing] = await db
      .select({ id: reminder.id, spec: reminderSchedule.spec })
      .from(reminder)
      .leftJoin(reminderSchedule, eq(reminderSchedule.reminderId, reminder.id))
      .where(
        and(
          eq(reminder.userId, it.userId),
          eq(reminder.sourceType, sourceType),
          eq(reminder.sourceId, it.sourceId),
          eq(reminder.ruleId, ruleId),
        ),
      )
      .limit(1);

    if (existing) {
      if (JSON.stringify(existing.spec) !== JSON.stringify(it.spec)) {
        await db
          .update(reminderSchedule)
          .set({ spec: it.spec, nextFireAt: computeNextFire(it.spec, now, 0), fireCount: 0, lastFiredAt: null })
          .where(eq(reminderSchedule.reminderId, existing.id));
      }
      continue;
    }

    const [created] = await db
      .insert(reminder)
      .values({
        userId: it.userId,
        title,
        bodyTemplate: body,
        sourceType,
        sourceId: it.sourceId,
        ruleId,
        priority: 'normal',
        silent: false,
        status: 'active',
      })
      .returning({ id: reminder.id });
    await db
      .insert(reminderSchedule)
      .values({ reminderId: created!.id, spec: it.spec, nextFireAt: computeNextFire(it.spec, now, 0) });
  }
}

/**
 * Синхронизация всех доменных авто-напоминаний с текущими данными (платежи,
 * документы). Идемпотентна; вызывается из диспетчера. Robust к любым путям правки
 * (включая каскадное удаление кредита) — сверяет состояние, а не хукает мутации.
 */
export async function reconcileDomainReminders(): Promise<void> {
  const today = utcToMoscowLocal(new Date()).slice(0, 10);

  // Платежи: ближайшие (scheduled) и просроченные (overdue).
  const payments = await db
    .select({
      id: creditsPayment.id,
      userId: creditsCredit.userId,
      dueDate: creditsPayment.dueDate,
      status: creditsPayment.status,
    })
    .from(creditsPayment)
    .innerJoin(creditsCredit, eq(creditsCredit.id, creditsPayment.creditId));

  const due: SyncItem[] = payments
    .filter((p) => p.status === 'scheduled')
    .map((p) => ({ userId: p.userId, sourceId: p.id, spec: datesSpec(p.dueDate, PAYMENT_DUE_OFFSETS) }));

  const overdue: SyncItem[] = payments
    .filter((p) => p.status === 'overdue')
    .map((p) => ({
      userId: p.userId,
      sourceId: p.id,
      // Ежедневный пинг от срока, пока не оплачено/не подтверждено.
      spec: { kind: 'recurring', freq: 'daily', interval: 1, startDate: p.dueDate, time: AUTO_TIME },
    }));

  const documents = await db
    .select({ id: documentsDocument.id, userId: documentsDocument.userId, expiryDate: documentsDocument.expiryDate })
    .from(documentsDocument)
    .where(
      and(
        eq(documentsDocument.isActive, true),
        sql`${documentsDocument.expiryDate} is not null`,
        sql`${documentsDocument.expiryDate} >= ${today}`,
      ),
    );

  const docs: SyncItem[] = documents
    .filter((d) => d.expiryDate)
    .map((d) => ({ userId: d.userId, sourceId: d.id, spec: datesSpec(d.expiryDate!, DOC_EXPIRY_OFFSETS) }));

  await syncRule(RULE_PAYMENT_DUE, 'payment', TPL.paymentDue.title, TPL.paymentDue.body, due);
  await syncRule(RULE_PAYMENT_OVERDUE, 'payment', TPL.paymentOverdue.title, TPL.paymentOverdue.body, overdue);
  await syncRule(RULE_DOC_EXPIRY, 'document', TPL.documentExpiry.title, TPL.documentExpiry.body, docs);
}
