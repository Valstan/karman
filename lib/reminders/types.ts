/**
 * Доменные типы напоминаний (#напоминалки, P0+).
 * Чистые типы — без `server-only`, можно импортировать из схемы, сервисов и тестов.
 */

export type ReminderSourceType = 'freeform' | 'payment' | 'document';
export type ReminderPriority = 'normal' | 'high';
export type ReminderStatus = 'active' | 'paused' | 'done' | 'archived';
export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped';
export type ReminderActionKind = 'ack' | 'snooze' | 'mark_paid' | 'done' | 'open';

/** Условие окончания серии напоминаний. */
export type ScheduleEnd =
  | { type: 'never' }
  | { type: 'afterN'; n: number }
  | { type: 'until'; until: string } // 'YYYY-MM-DD' (московская дата)
  | { type: 'untilAcked' };

/** Тихие часы: не слать с `from` до `to`, перенести на `deferTo` (всё 'HH:MM' МСК). */
export type QuietHours = { from: string; to: string; deferTo: string };

type ScheduleSpecBase = {
  end?: ScheduleEnd;
  quietHours?: QuietHours;
  businessDaysOnly?: boolean;
  /** IANA-таймзона; по умолчанию 'Europe/Moscow'. */
  tz?: string;
};

/**
 * Спецификация расписания (jsonb в reminder_schedule.spec). wall-clock-поля
 * (`at`, `times`, `until`) — московские строки; нормализованный UTC-инстант
 * срабатывания лежит отдельно в reminder_schedule.next_fire_at (его и читает
 * горячий due-scan). Полный движок вычисления — P3 (lib/reminders/schedule).
 */
export type ScheduleSpec =
  | (ScheduleSpecBase & { kind: 'oneoff'; at: string }) // 'YYYY-MM-DDTHH:MM'
  | (ScheduleSpecBase & { kind: 'dates'; dates: string[]; times: string[] })
  | (ScheduleSpecBase & { kind: 'rrule'; rrule: string; times: string[] })
  | (ScheduleSpecBase & {
      kind: 'relative';
      anchor: { source: 'payment' | 'document'; field: string };
      offsets: string[]; // напр. ['-14d','-7d','-3d','-1d','0d']
      times: string[];
    });
