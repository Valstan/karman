import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { creditsCredit, creditsPayment, documentsDocument } from '@/lib/db/schema';
import { renderReminderText } from '@/lib/reminders/render';
import { formatMoney } from '@/lib/format';
import { DOC_WINDOW_DAYS, UPCOMING_WINDOW_DAYS } from '@/lib/reminders/domain-templates';
import type { ReminderSourceType } from '@/lib/reminders/types';

export type RenderedMessage = { valid: boolean; text: string };

type RenderRow = {
  sourceType: ReminderSourceType;
  sourceId: number | null;
  userId: number;
  title: string;
  body: string;
};

/**
 * Готовит текст сообщения. Для дайджеста собирает сводку из ЖИВЫХ данных
 * пользователя (к оплате скоро / просрочено / истекающие документы). Если в этот
 * день нечего сообщить — {valid:false} (диспетчер пропустит и перенесёт на завтра).
 */
export async function renderReminderMessage(row: RenderRow): Promise<RenderedMessage> {
  if (row.sourceType === 'digest') {
    return renderDigest(row.userId);
  }
  // freeform (и любой иной — на всякий случай) — обычный текст напоминания.
  return { valid: true, text: renderReminderText(row.title, row.body) };
}

async function renderDigest(userId: number): Promise<RenderedMessage> {
  const [up] = await db
    .select({
      n: sql<number>`count(*)::int`,
      s: sql<string>`coalesce(sum(${creditsPayment.amount}), 0)::text`,
    })
    .from(creditsPayment)
    .innerJoin(creditsCredit, eq(creditsCredit.id, creditsPayment.creditId))
    .where(
      and(
        eq(creditsCredit.userId, userId),
        eq(creditsPayment.status, 'scheduled'),
        sql`${creditsPayment.dueDate} between CURRENT_DATE and CURRENT_DATE + make_interval(days => ${UPCOMING_WINDOW_DAYS})`,
      ),
    );

  const [ov] = await db
    .select({
      n: sql<number>`count(*)::int`,
      s: sql<string>`coalesce(sum(${creditsPayment.amount}), 0)::text`,
    })
    .from(creditsPayment)
    .innerJoin(creditsCredit, eq(creditsCredit.id, creditsPayment.creditId))
    .where(and(eq(creditsCredit.userId, userId), eq(creditsPayment.status, 'overdue')));

  const [dc] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documentsDocument)
    .where(
      and(
        eq(documentsDocument.userId, userId),
        eq(documentsDocument.isActive, true),
        sql`${documentsDocument.expiryDate} is not null`,
        sql`${documentsDocument.expiryDate} between CURRENT_DATE and CURRENT_DATE + make_interval(days => ${DOC_WINDOW_DAYS})`,
      ),
    );

  const nUp = up?.n ?? 0;
  const nOv = ov?.n ?? 0;
  const nDoc = dc?.n ?? 0;
  if (nUp === 0 && nOv === 0 && nDoc === 0) {
    return { valid: false, text: '' };
  }

  const lines = ['📋 <b>Сводка KARMAN</b>'];
  if (nUp > 0) lines.push(`💳 К оплате (${UPCOMING_WINDOW_DAYS} дн.): <b>${nUp}</b> на ${formatMoney(up!.s)}`);
  if (nOv > 0) lines.push(`🔴 Просрочено: <b>${nOv}</b> на ${formatMoney(ov!.s)}`);
  if (nDoc > 0) lines.push(`📄 Истекает документов (${DOC_WINDOW_DAYS} дн.): <b>${nDoc}</b>`);
  return { valid: true, text: lines.join('\n') };
}
