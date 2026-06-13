/**
 * Доменные авто-напоминания (P4): шаблоны и смещения. {плейсхолдеры} подставляются
 * на отправке из живой строки источника (lib/services/reminder-render).
 * Время авто-напоминаний — 10:00 МСК; смещения настраиваемы здесь.
 */

export const AUTO_TIME = '10:00';

/** Дней до due_date платежа (решение владельца: за 3 и 1 день). */
export const PAYMENT_DUE_OFFSETS = [3, 1];
/** Дней до expiry_date документа. */
export const DOC_EXPIRY_OFFSETS = [30, 7, 1];

export const RULE_PAYMENT_DUE = 'payment_due';
export const RULE_PAYMENT_OVERDUE = 'payment_overdue';
export const RULE_DOC_EXPIRY = 'document_expiry';

export const TPL = {
  paymentDue: {
    title: 'Платёж по кредиту «{кредит}»',
    body: 'Через {дней} дн. внести {сумма}. Банк: {банк}, до {дата}.',
  },
  paymentOverdue: {
    title: '⚠️ Просрочен платёж «{кредит}»',
    body: 'Не оплачено {сумма}. Банк: {банк}, срок был {дата}.',
  },
  documentExpiry: {
    title: 'Истекает документ «{документ}»',
    body: 'Срок действия до {дата} (через {дней} дн.).',
  },
} as const;
