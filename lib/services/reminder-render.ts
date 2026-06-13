import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { creditsBank, creditsCredit, creditsPayment, documentsDocument } from '@/lib/db/schema';
import { renderReminderText } from '@/lib/reminders/render';
import { substitute } from '@/lib/reminders/template';
import { formatDate, formatMoney } from '@/lib/format';
import { daysUntil } from '@/lib/dates';
import type { ReminderSourceType } from '@/lib/reminders/types';

export type RenderedMessage = { valid: boolean; text: string };

/**
 * Готовит текст сообщения. Для доменных напоминаний подставляет переменные из
 * ЖИВОЙ строки источника и проверяет актуальность: оплаченный платёж / удалённый
 * или неактивный документ → {valid:false} (диспетчер пропустит и продвинет).
 */
export async function renderReminderMessage(row: {
  sourceType: ReminderSourceType;
  sourceId: number | null;
  title: string;
  body: string;
}): Promise<RenderedMessage> {
  if (row.sourceType === 'freeform' || row.sourceId === null) {
    return { valid: true, text: renderReminderText(row.title, row.body) };
  }

  if (row.sourceType === 'payment') {
    const [p] = await db
      .select({
        amount: creditsPayment.amount,
        dueDate: creditsPayment.dueDate,
        status: creditsPayment.status,
        creditName: creditsCredit.name,
        bankName: creditsBank.name,
      })
      .from(creditsPayment)
      .innerJoin(creditsCredit, eq(creditsCredit.id, creditsPayment.creditId))
      .innerJoin(creditsBank, eq(creditsBank.id, creditsCredit.bankId))
      .where(eq(creditsPayment.id, row.sourceId))
      .limit(1);
    if (!p || p.status === 'paid') {
      return { valid: false, text: '' };
    }
    const vars: Record<string, string> = {
      кредит: p.creditName?.trim() ? p.creditName : p.bankName,
      сумма: formatMoney(p.amount),
      банк: p.bankName,
      дата: formatDate(p.dueDate),
      дней: String(Math.max(0, daysUntil(p.dueDate))),
    };
    return { valid: true, text: renderReminderText(substitute(row.title, vars), substitute(row.body, vars)) };
  }

  // document
  const [d] = await db
    .select({
      title: documentsDocument.title,
      expiryDate: documentsDocument.expiryDate,
      isActive: documentsDocument.isActive,
    })
    .from(documentsDocument)
    .where(eq(documentsDocument.id, row.sourceId))
    .limit(1);
  if (!d || !d.isActive || !d.expiryDate) {
    return { valid: false, text: '' };
  }
  const vars: Record<string, string> = {
    документ: d.title,
    дата: formatDate(d.expiryDate),
    дней: String(Math.max(0, daysUntil(d.expiryDate))),
  };
  return { valid: true, text: renderReminderText(substitute(row.title, vars), substitute(row.body, vars)) };
}
