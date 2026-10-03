import { z } from 'zod';
import { money, optionalMoney, dateString, optionalDateString } from './common';

export const PAYMENT_STATUSES = ['scheduled', 'overdue', 'paid'] as const;

export const paymentCreateSchema = z.object({
  creditId: z.coerce.number().int().positive(),
  amount: money,
  principalAmount: optionalMoney,
  interestAmount: optionalMoney,
  dueDate: dateString,
  paidDate: optionalDateString,
  status: z.enum(PAYMENT_STATUSES).default('scheduled'),
});

/**
 * Правка платежа — единственное место, где «поле не передали» и «поле стёрли» должны
 * различаться, поэтому nullable-поля здесь БЕЗ финального `.transform(v ?? null)`.
 *
 * `optionalMoney`/`optionalDateString` (G54/G70) приводят отсутствующий ключ к `null`, и
 * для чтения это верно — но для частичного UPDATE это ловушка: patch собирается по
 * `!== undefined`, условие срабатывает всегда, и кнопка «отметить оплаченным»
 * (шлёт `{ id, status, paidDate }`) молча затирала разбивку тело/проценты на `'0.00'`
 * у только что оплаченного платежа. Регенерация графика paid-строки не трогает, то есть
 * ломалось без возможности починиться (аудит #057, H3).
 *
 * В Zod v4 отсутствующий `.optional()`-ключ в выходном объекте ПРОПУЩЕН, а не приведён к
 * `undefined` — на этом и стоит различение: «не передали» → `undefined` → поле не трогаем,
 * «передали null» → поле чистим осознанно.
 */
export const paymentUpdateSchema = z.object({
  id: z.coerce.number().int().positive(),
  amount: money.optional(),
  principalAmount: money.nullable().optional(),
  interestAmount: money.nullable().optional(),
  dueDate: dateString.optional(),
  paidDate: dateString.nullable().optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
});

export type PaymentCreateInput = z.infer<typeof paymentCreateSchema>;
export type PaymentUpdateInput = z.infer<typeof paymentUpdateSchema>;
