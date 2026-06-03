import { z } from 'zod';
import { money, optionalMoney, dateString } from './common';

export const PAYMENT_TYPES = ['annuity', 'differentiated', 'other'] as const;
export const CREDIT_STATUSES = ['active', 'overdue', 'closed'] as const;

export const creditCreateSchema = z.object({
  name: z.string().trim().max(200).optional().default(''),
  description: z.string().trim().max(2000).optional().default(''),
  bankId: z.coerce.number().int().positive('Выберите банк'),
  amount: money,
  interestRate: money,
  monthlyPayment: optionalMoney,
  paymentType: z.enum(PAYMENT_TYPES).default('annuity'),
  startDate: dateString,
  status: z.enum(CREDIT_STATUSES).default('active'),
  termMonths: z.coerce.number().int().min(1, 'Минимум 1 месяц').max(600),
  // Сгенерировать график платежей автоматически при создании.
  generateSchedule: z.coerce.boolean().optional().default(true),
});

export const creditUpdateSchema = creditCreateSchema
  .omit({ generateSchedule: true })
  .partial()
  .extend({ id: z.coerce.number().int().positive() });

export type CreditCreateInput = z.infer<typeof creditCreateSchema>;
export type CreditUpdateInput = z.infer<typeof creditUpdateSchema>;
