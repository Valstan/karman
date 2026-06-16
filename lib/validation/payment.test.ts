import { describe, it, expect } from 'vitest';
import { paymentCreateSchema, paymentUpdateSchema } from './payment';

// Регрессия Zod v4: union-с-undefined ≠ опциональный ключ. Голые optionalMoney/
// optionalDateString падали с "expected nonoptional", если форма ОПУСКАЛА ключ.

describe('paymentUpdateSchema', () => {
  it('парсит markPaid-пейлоад без principalAmount/interestAmount (баг кнопки «оплачено»)', () => {
    // payment-schedule-table.tsx → markPaid шлёт только id/status/paidDate.
    const r = paymentUpdateSchema.safeParse({ id: 1, status: 'paid', paidDate: '2026-06-16' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.principalAmount).toBe(null);
      expect(r.data.interestAmount).toBe(null);
      expect(r.data.paidDate).toBe('2026-06-16');
    }
  });
});

describe('paymentCreateSchema', () => {
  it('парсит создание без опциональных денег/дат (ключи опущены → null)', () => {
    const r = paymentCreateSchema.safeParse({ creditId: 1, amount: '100', dueDate: '2026-06-16' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.principalAmount).toBe(null);
      expect(r.data.interestAmount).toBe(null);
      expect(r.data.paidDate).toBe(null);
    }
  });

  it('пустая строка опционального поля → null, значение нормализуется', () => {
    const r = paymentCreateSchema.safeParse({
      creditId: 1,
      amount: '100',
      dueDate: '2026-06-16',
      principalAmount: '',
      interestAmount: '1,50',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.principalAmount).toBe(null);
      expect(r.data.interestAmount).toBe('1.50');
    }
  });

  it('мусор в опциональной сумме отвергается', () => {
    const r = paymentCreateSchema.safeParse({
      creditId: 1,
      amount: '100',
      dueDate: '2026-06-16',
      principalAmount: 'abc',
    });
    expect(r.success).toBe(false);
  });
});
