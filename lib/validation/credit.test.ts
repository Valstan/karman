import { describe, it, expect } from 'vitest';
import { creditCreateSchema } from './credit';

// Регрессия Zod v4 (см. payment.test.ts): monthlyPayment — голый optionalMoney;
// опущенный ключ давал "expected nonoptional".

const base = {
  bankId: 1,
  amount: '100000',
  interestRate: '12',
  startDate: '2026-06-16',
  termMonths: 12,
};

describe('creditCreateSchema', () => {
  it('парсит создание без monthlyPayment (ключ опущен → null)', () => {
    const r = creditCreateSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.monthlyPayment).toBe(null);
  });

  it('пустая строка → null, значение нормализуется', () => {
    expect(creditCreateSchema.safeParse({ ...base, monthlyPayment: '' }).data?.monthlyPayment).toBe(null);
    const r = creditCreateSchema.safeParse({ ...base, monthlyPayment: '5000,50' });
    expect(r.success && r.data.monthlyPayment).toBe('5000.50');
  });

  it('мусор отвергается', () => {
    expect(creditCreateSchema.safeParse({ ...base, monthlyPayment: 'xx' }).success).toBe(false);
  });
});
