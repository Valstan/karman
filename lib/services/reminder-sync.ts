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
 * Что сделал проход синхронизации — возвращается наружу и пишется в след.
 *
 * Мандат brain 19.11 (портретный разбор D-238): «синхронизация доменных напоминаний
 * раз в 25 секунд пишет и удаляет строки в прод-БД, и следа нет». След нужен **на каждый
 * проход**, даже когда изменений нет: иначе «задача идёт» и «задача молчала» неразличимы.
 */
export type DomainReminderSyncResult = {
  /** Сколько дайджестов удалено у отвязавшихся пользователей. */
  deleted: number;
  /** Сколько дайджестов создано. */
  created: number;
  /** Сколько расписаний починено (был пустой next_fire). */
  repaired: number;
  /** Синхронизация выключена выключателем `REMINDER_SYNC_ENABLED`. */
  disabled: boolean;
};

/**
 * Выключатель синхронизации доменных напоминаний (мандат brain 19.11: «выключатель рядом
 * с задачей, чтобы синхронизацию можно было снять, не трогая диспетчер напоминаний»).
 *
 * По умолчанию — включено (поведение не меняется молча). Выключается значениями
 * `0`, `false`, `off`, `no`.
 */
export function reminderSyncEnabled(): boolean {
  const raw = process.env.REMINDER_SYNC_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  return !['0', 'false', 'off', 'no', 'нет', 'выкл'].includes(raw);
}

/**
 * Обеспечивает по одному ежедневному дайджест-напоминанию на каждого пользователя
 * с привязанным активным Telegram-чатом; удаляет дайджесты отвязавшихся. Контент
 * собирается на отправке (reminder-render); если в этот день нечего сообщить —
 * диспетчер пропустит отправку и перенесёт на завтра. Идемпотентно; зовётся из диспетчера.
 *
 * Удаление дайджестов у отвязавшихся — не «чистка по сроку» (срока в условии нет), а
 * уборка по отвязке Telegram-чата у живого фича «Сводка KARMAN»: отвязался — дайджест
 * больше не нужен. Поэтому след на каждый проход обязателен (мандат brain 19.11).
 */
export async function reconcileDomainReminders(): Promise<DomainReminderSyncResult> {
  if (!reminderSyncEnabled()) {
    const result: DomainReminderSyncResult = { deleted: 0, created: 0, repaired: 0, disabled: true };
    console.log('[reminders/sync] синхронизация доменных напоминаний выключена (REMINDER_SYNC_ENABLED)');
    return result;
  }

  const linked = await db
    .select({ userId: telegramLink.userId })
    .from(telegramLink)
    .where(and(isNotNull(telegramLink.chatId), eq(telegramLink.isActive, true)));
  const userIds = linked.map((l) => l.userId);

  // Снять дайджесты у отвязавшихся пользователей.
  const removed = await db
    .delete(reminder)
    .where(
      and(
        eq(reminder.sourceType, 'digest'),
        eq(reminder.ruleId, RULE_DIGEST),
        userIds.length ? notInArray(reminder.userId, userIds) : sql`true`,
      ),
    )
    .returning({ id: reminder.id });

  const now = new Date().toISOString();
  let created = 0;
  let repaired = 0;
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
        repaired += 1;
      }
      continue;
    }
    const [row] = await db
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
      .values({ reminderId: row!.id, spec: DIGEST_SPEC, nextFireAt: computeNextFire(DIGEST_SPEC, now, 0) });
    created += 1;
  }

  const result: DomainReminderSyncResult = {
    deleted: removed.length,
    created,
    repaired,
    disabled: false,
  };
  // След на КАЖДЫЙ проход — даже когда ничего не изменилось (мандат brain 19.11).
  console.log(
    `[reminders/sync] синхронизация доменных напоминаний: удалено ${result.deleted}, создано ${result.created}, починено расписаний ${result.repaired}`,
  );
  return result;
}
