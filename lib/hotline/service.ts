import 'server-only';
import { and, asc, desc, gt, lt } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { hotlineMessage, hotlinePresence } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { HotlineKind, HotlineLineState } from '@/lib/hotline/validation';

/**
 * Сторож линии (мандат brain 05.10, D-113): тик в диалоге — не реже раза в
 * TICK_SECONDS, два пропуска подряд — авто-отбой. Один пропуск терпим (сбой
 * сети), два — смерть сессии. Sweep, а не cron: таблица truthful после каждого
 * обращения к presence, отдельного расписания нет.
 */
export const HOTLINE_TICK_SECONDS = 30;
export const HOTLINE_MISSED_TICKS = 2;
export const HOTLINE_STALE_AFTER_MS = HOTLINE_TICK_SECONDS * HOTLINE_MISSED_TICKS * 1000;

/**
 * Тонкий слой relay поверх Drizzle: валидация и линт — в роуте до вызова,
 * здесь только запись и чтение. Тестов с БД нет (харнесса нет — R1): держать
 * функции короче, чем объяснение, почему они корректны.
 */

export async function postHotlineMessage(input: {
  room: string;
  sender: string;
  kind: HotlineKind;
  text: string;
}) {
  const [row] = await db
    .insert(hotlineMessage)
    .values({ room: input.room, sender: input.sender, kind: input.kind, text: input.text })
    .returning({ id: hotlineMessage.id, createdAt: hotlineMessage.createdAt });
  return row;
}

export async function readHotlineMessages(room: string, sinceId: number, limit: number) {
  return db
    .select({
      id: hotlineMessage.id,
      room: hotlineMessage.room,
      sender: hotlineMessage.sender,
      kind: hotlineMessage.kind,
      text: hotlineMessage.text,
      createdAt: hotlineMessage.createdAt,
    })
    .from(hotlineMessage)
    .where(and(eq(hotlineMessage.room, room), gt(hotlineMessage.id, sinceId)))
    .orderBy(asc(hotlineMessage.id))
    .limit(limit);
}

export async function heartbeatPresence(
  label: string,
  aliveMinutes: number,
  lineState?: HotlineLineState,
) {
  const aliveUntil = new Date(Date.now() + aliveMinutes * 60_000).toISOString();
  // G54-линза: поле опционально в контракте — тик без него обязан оставить
  // состояние как было, а не сбросить в дефолт. Поэтому два пути записи:
  // событие (с полем) и чистый heartbeat (без поля).
  const set: { aliveUntil: string; updatedAt: string; lineState?: string } = {
    aliveUntil,
    updatedAt: new Date().toISOString(),
  };
  if (lineState !== undefined) {
    set.lineState = lineState;
  }
  await db.insert(hotlinePresence).values({ label, aliveUntil }).onConflictDoUpdate({
    target: hotlinePresence.label,
    set,
  });
  // Возвращаем хранимое состояние, а не эхо входа: тик без поля обязан
  // увидеть прежнее значение (G54-контроль пары «поле прошло все слои»).
  const [row] = await db
    .select({ lineState: hotlinePresence.lineState })
    .from(hotlinePresence)
    .where(eq(hotlinePresence.label, label));
  return { label, alive_until: aliveUntil, line_state: row?.lineState ?? 'offline' };
}

/**
 * Авто-отбой: строки 'on_line', чей последний тик старше двух каденсов, —
 * в 'offline'. Трогает только линию в разговоре; sparse-тики вне диалога
 * (состояние 'offline') не задевает никогда. Возвращает число погашенных.
 */
export async function sweepStaleLines(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - HOTLINE_STALE_AFTER_MS).toISOString();
  const stale = await db
    .update(hotlinePresence)
    .set({ lineState: 'offline', updatedAt: now.toISOString() })
    .where(and(eq(hotlinePresence.lineState, 'on_line'), lt(hotlinePresence.updatedAt, cutoff)))
    .returning({ label: hotlinePresence.label });
  return stale.length;
}

export async function readPresence() {
  // Ленивый sweep на чтении (выбор зафиксирован в docs/hotline-relay.md):
  // таблица truthful для обоих читателей без отдельного расписания.
  await sweepStaleLines();
  return db
    .select({
      label: hotlinePresence.label,
      lineState: hotlinePresence.lineState,
      aliveUntil: hotlinePresence.aliveUntil,
      updatedAt: hotlinePresence.updatedAt,
    })
    .from(hotlinePresence)
    .orderBy(desc(hotlinePresence.updatedAt));
}
