import 'server-only';
import { and, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { reminder, reminderDelivery, reminderSchedule, telegramLink } from '@/lib/db/schema';
import { sendMessage } from '@/lib/telegram/client';
import { buildReminderKeyboard } from '@/lib/telegram/keyboards';
import { computeNextFire } from '@/lib/reminders/schedule';
import { reconcileDomainReminders } from '@/lib/services/reminder-sync';
import { renderReminderMessage } from '@/lib/services/reminder-render';
import type { ScheduleSpec } from '@/lib/reminders/types';

// Произвольная константа advisory-lock — единственный диспетчер за раз (single-flight
// без redis): пересекающиеся тики воркера не шлют дважды.
const DISPATCH_LOCK_KEY = 738_201;
const BATCH_LIMIT = 200;

export type DispatchResult = {
  scanned: number;
  sent: number;
  failed: number;
  skipped: number;
  locked?: boolean;
};

async function tryLock(): Promise<boolean> {
  const res = await db.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_lock(${DISPATCH_LOCK_KEY}) AS locked`,
  );
  return res.rows[0]?.locked === true;
}

async function unlock(): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_unlock(${DISPATCH_LOCK_KEY})`);
}

/**
 * Скан созревших напоминаний и отправка в Telegram. Идемпотентность — на
 * UNIQUE(reminder_id, fire_slot): claim слота через ON CONFLICT DO NOTHING.
 */
export async function dispatchDueReminders(): Promise<DispatchResult> {
  if (!(await tryLock())) {
    return { scanned: 0, sent: 0, failed: 0, skipped: 0, locked: true };
  }
  try {
    // Синхронизируем доменные авто-напоминания (платежи/документы) с текущими данными.
    try {
      await reconcileDomainReminders();
    } catch (error) {
      console.error('[reminders/dispatch] reconcile error', error);
    }

    const due = await db
      .select({
        scheduleId: reminderSchedule.id,
        reminderId: reminderSchedule.reminderId,
        nextFireAt: reminderSchedule.nextFireAt,
        spec: reminderSchedule.spec,
        fireCount: reminderSchedule.fireCount,
        userId: reminder.userId,
        title: reminder.title,
        body: reminder.bodyTemplate,
        sourceType: reminder.sourceType,
        sourceId: reminder.sourceId,
        silent: reminder.silent,
      })
      .from(reminderSchedule)
      .innerJoin(reminder, eq(reminder.id, reminderSchedule.reminderId))
      .where(
        and(
          isNotNull(reminderSchedule.nextFireAt),
          lte(reminderSchedule.nextFireAt, sql`now()`),
          eq(reminder.status, 'active'),
        ),
      )
      .orderBy(reminderSchedule.nextFireAt)
      .limit(BATCH_LIMIT);

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const row of due) {
      const fireSlot = row.nextFireAt!;

      // Claim слота — защита от двойной отправки.
      const claim = await db
        .insert(reminderDelivery)
        .values({
          reminderId: row.reminderId,
          scheduleId: row.scheduleId,
          fireSlot,
          status: 'pending',
        })
        .onConflictDoNothing({ target: [reminderDelivery.reminderId, reminderDelivery.fireSlot] })
        .returning({ id: reminderDelivery.id });

      if (claim.length === 0) {
        continue; // слот уже обработан другим тиком
      }
      const deliveryId = claim[0]!.id;

      const [link] = await db
        .select()
        .from(telegramLink)
        .where(eq(telegramLink.userId, row.userId))
        .limit(1);

      if (!link?.chatId || !link.isActive) {
        await markDelivery(deliveryId, 'skipped', 'Telegram не привязан');
        await advance(row.scheduleId, row.spec, fireSlot, row.fireCount);
        skipped += 1;
        continue;
      }

      // Доменные напоминания: подстановка из живой строки + проверка актуальности.
      const msg = await renderReminderMessage({
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        title: row.title,
        body: row.body,
      });
      if (!msg.valid) {
        await markDelivery(deliveryId, 'skipped', 'источник неактуален (оплачен/удалён)');
        await advance(row.scheduleId, row.spec, fireSlot, row.fireCount);
        skipped += 1;
        continue;
      }
      const res = await sendMessage({
        chatId: link.chatId,
        text: msg.text,
        disableNotification: row.silent,
        replyMarkup: buildReminderKeyboard(deliveryId),
      });

      if (res.ok) {
        await db
          .update(reminderDelivery)
          .set({
            status: 'sent',
            tgChatId: link.chatId,
            tgMessageId: res.result.message_id,
            sentAt: new Date().toISOString(),
          })
          .where(eq(reminderDelivery.id, deliveryId));
        await advance(row.scheduleId, row.spec, fireSlot, row.fireCount);
        sent += 1;
      } else if (res.kind === 'rate_limited') {
        // Бэкофф: оставляем pending, прерываем батч — добьём на следующем тике.
        await db
          .update(reminderDelivery)
          .set({ attempts: sql`${reminderDelivery.attempts} + 1`, lastError: res.description })
          .where(eq(reminderDelivery.id, deliveryId));
        break;
      } else {
        if (res.kind === 'blocked') {
          await db.update(telegramLink).set({ isActive: false }).where(eq(telegramLink.id, link.id));
        }
        await markDelivery(deliveryId, 'failed', res.description);
        await advance(row.scheduleId, row.spec, fireSlot, row.fireCount);
        failed += 1;
      }
    }

    return { scanned: due.length, sent, failed, skipped };
  } finally {
    await unlock();
  }
}

async function markDelivery(id: number, status: 'failed' | 'skipped', error: string): Promise<void> {
  await db
    .update(reminderDelivery)
    .set({ status, lastError: error, attempts: sql`${reminderDelivery.attempts} + 1` })
    .where(eq(reminderDelivery.id, id));
}

async function advance(
  scheduleId: number,
  spec: ScheduleSpec,
  firedSlotIso: string,
  oldFireCount: number,
): Promise<void> {
  const newCount = oldFireCount + 1;
  await db
    .update(reminderSchedule)
    .set({
      // Следующее срабатывание строго после только что сработавшего слота.
      nextFireAt: computeNextFire(spec, firedSlotIso, newCount),
      lastFiredAt: new Date().toISOString(),
      fireCount: newCount,
    })
    .where(eq(reminderSchedule.id, scheduleId));
}
