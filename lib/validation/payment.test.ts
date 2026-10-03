import { describe, it, expect } from 'vitest';
import { paymentCreateSchema, paymentUpdateSchema } from './payment';

// Регрессия Zod v4: union-с-undefined ≠ опциональный ключ. Голые optionalMoney/
// optionalDateString падали с "expected nonoptional", если форма ОПУСКАЛА ключ.

describe('paymentUpdateSchema', () => {
  /**
   * Аудит #057, H3.
   *
   * Тест раньше ЗАКРЕПЛЯЛ дефект: он утверждал, что markPaid-пейлоад без разбивки приходит
   * с `principalAmount === null`, и тем самым делал баг «ожидаемым поведением». На деле
   * `updatePayment` собирает patch по `!== undefined`, `null` условие проходил, и кнопка
   * «отметить оплаченным» молча затирала тело/проценты на `'0.00'` — при том что
   * регенерация графика paid-строки не трогает, то есть ломалось без возможности
   * починиться.
   *
   * Теперь «не передали» и «стёрли» — разные вещи: отсутствующий ключ в Zod v4
   * ПРОПУЩЕН в выходном объекте, и patch поле не трогает.
   */
  it('отсутствующая разбивка в markPaid-пейлоаде остаётся отсутствующей', () => {
    // payment-schedule-table.tsx → markPaid шлёт только id/status/paidDate.
    const r = paymentUpdateSchema.safeParse({ id: 1, status: 'paid', paidDate: '2026-06-16' });
    expect(r.success).toBe(true);
    if (r.success) {
      const data = r.data as Record<string, unknown>;
      expect(data.principalAmount).toBeUndefined();
      expect(data.interestAmount).toBeUndefined();
      expect(data.paidDate).toBe('2026-06-16');
      // «Стёрли» — это явный null, и он обязан остаться различимым.
      expect(Object.hasOwn(data, 'principalAmount')).toBe(false);
    }
  });

  it('явный null значит «очистить» и не путается с «не передали»', () => {
    const r = paymentUpdateSchema.safeParse({ id: 1, paidDate: null });
    expect(r.success).toBe(true);
    if (r.success) {
      const data = r.data as Record<string, unknown>;
      expect(data.paidDate).toBeNull();
      expect(Object.hasOwn(data, 'paidDate')).toBe(true);
      expect(data.principalAmount).toBeUndefined();
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
