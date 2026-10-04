import 'server-only';
import { and, asc, desc, gt } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { hotlineMessage, hotlinePresence } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { HotlineKind } from '@/lib/hotline/validation';

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

export async function heartbeatPresence(label: string, aliveMinutes: number) {
  const aliveUntil = new Date(Date.now() + aliveMinutes * 60_000).toISOString();
  await db
    .insert(hotlinePresence)
    .values({ label, aliveUntil })
    .onConflictDoUpdate({
      target: hotlinePresence.label,
      set: { aliveUntil, updatedAt: new Date().toISOString() },
    });
  return { label, alive_until: aliveUntil };
}

export async function readPresence() {
  return db
    .select({
      label: hotlinePresence.label,
      aliveUntil: hotlinePresence.aliveUntil,
      updatedAt: hotlinePresence.updatedAt,
    })
    .from(hotlinePresence)
    .orderBy(desc(hotlinePresence.updatedAt));
}
