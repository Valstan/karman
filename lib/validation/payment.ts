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

export const paymentUpdateSchema = z.object({
  id: z.coerce.number().int().positive(),
  amount: money.optional(),
  principalAmount: optionalMoney,
  interestAmount: optionalMoney,
  dueDate: dateString.optional(),
  paidDate: optionalDateString,
  status: z.enum(PAYMENT_STATUSES).optional(),
});

export type PaymentCreateInput = z.infer<typeof paymentCreateSchema>;
export type PaymentUpdateInput = z.infer<typeof paymentUpdateSchema>;
