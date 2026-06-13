import 'server-only';
import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { telegramLink } from '@/lib/db/schema';
import type { TelegramLinkRow } from '@/lib/db/schema';

const LINK_CODE_TTL_MINUTES = 15;

export async function getLinkForUser(userId: number): Promise<TelegramLinkRow | null> {
  const [row] = await db.select().from(telegramLink).where(eq(telegramLink.userId, userId)).limit(1);
  return row ?? null;
}

/**
 * Генерирует одноразовый код привязки и (пере)записывает строку telegram_link
 * пользователя. Существующая привязка chat_id не трогается — код нужен лишь для
 * нового `/start <code>`.
 */
export async function generateLinkCode(userId: number): Promise<string> {
  const code = randomBytes(16).toString('hex');
  const expires = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60_000).toISOString();

  await db
    .insert(telegramLink)
    .values({ userId, linkCode: code, linkCodeExpiresAt: expires })
    .onConflictDoUpdate({
      target: telegramLink.userId,
      set: { linkCode: code, linkCodeExpiresAt: expires, updatedAt: new Date().toISOString() },
    });

  return code;
}

/**
 * Привязка чата по одноразовому коду (вызывается из обработки `/start <code>`).
 * Возвращает userId при успехе, иначе null (код неверен/просрочен).
 */
export async function linkChatByCode(
  code: string,
  chatId: number,
  username: string | undefined,
): Promise<number | null> {
  const updated = await db
    .update(telegramLink)
    .set({
      chatId,
      tgUsername: username ?? null,
      isActive: true,
      linkCode: null,
      linkCodeExpiresAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(telegramLink.linkCode, code),
        isNotNull(telegramLink.linkCodeExpiresAt),
        gt(telegramLink.linkCodeExpiresAt, sql`now()`),
      ),
    )
    .returning({ userId: telegramLink.userId });

  return updated[0]?.userId ?? null;
}
