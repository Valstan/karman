import 'server-only';
import { and, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { reminder, reminderSchedule, telegramLink } from '@/lib/db/schema';
import { computeNextFire } from '@/lib/reminders/schedule';
import { DIGEST_ANCHOR, DIGEST_TIME, RULE_DIGEST } from '@/lib/reminders/domain-templates';
import type { ScheduleSpec } from '@/lib/reminders/types';

// Стабильная спека ежедневного дайджеста (фиксированный якорь → reconcile не сбрасывает).
const DIGEST_SPEC: ScheduleSpec = {
  kind: 'recurring',
  freq: 'daily',
  interval: 1,
  startDate: DIGEST_ANCHOR,
  time: DIGEST_TIME,
};

/**
 * Обеспечивает по одному ежедневному дайджест-напоминанию на каждого пользователя
 * с привязанным активным Telegram-чатом; удаляет дайджесты отвязавшихся. Контент
 * собирается на отправке (reminder-render); если в этот день нечего сообщить —
 * диспетчер пропустит отправку и перенесёт на завтра. Идемпотентно; зовётся из диспетчера.
 */
export async function reconcileDomainReminders(): Promise<void> {
  const linked = await db
    .select({ userId: telegramLink.userId })
    .from(telegramLink)
    .where(and(isNotNull(telegramLink.chatId), eq(telegramLink.isActive, true)));
  const userIds = linked.map((l) => l.userId);

  // Снять дайджесты у отвязавшихся пользователей.
  await db.delete(reminder).where(
    and(
      eq(reminder.sourceType, 'digest'),
      eq(reminder.ruleId, RULE_DIGEST),
      userIds.length ? notInArray(reminder.userId, userIds) : sql`true`,
    ),
  );

  const now = new Date().toISOString();
  for (const userId of userIds) {
    const [existing] = await db
      .select({ id: reminder.id, nextFireAt: reminderSchedule.nextFireAt })
      .from(reminder)
      .leftJoin(reminderSchedule, eq(reminderSchedule.reminderId, reminder.id))
      .where(
        and(
          eq(reminder.userId, userId),
          eq(reminder.sourceType, 'digest'),
          eq(reminder.ruleId, RULE_DIGEST),
        ),
      )
      .limit(1);
    if (existing) {
      // Дайджест ежедневный и бессрочный — next_fire не должен быть null. Чиним, если так
      // (напр. после исправления движка). Иначе не трогаем — сохраняем прогресс/паузу.
      if (existing.nextFireAt === null) {
        await db
          .update(reminderSchedule)
          .set({ nextFireAt: computeNextFire(DIGEST_SPEC, now, 0) })
          .where(eq(reminderSchedule.reminderId, existing.id));
      }
      continue;
    }
    const [created] = await db
      .insert(reminder)
      .values({
        userId,
        title: 'Сводка KARMAN',
        bodyTemplate: '',
        sourceType: 'digest',
        ruleId: RULE_DIGEST,
        priority: 'normal',
        silent: false,
        status: 'active',
      })
      .returning({ id: reminder.id });
    await db
      .insert(reminderSchedule)
      .values({ reminderId: created!.id, spec: DIGEST_SPEC, nextFireAt: computeNextFire(DIGEST_SPEC, now, 0) });
  }
}
