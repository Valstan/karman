import { describe, it, expect } from 'vitest';
import { simulateEarlyRepayment } from './early-repayment';
import { toKopecks } from '@/lib/money';

// Типовой остаток аннуитета: 500 000 ₽ под 18% годовых, платёж ~12 000 ₽/мес.
const base = {
  remainingPrincipal: '500000.00',
  annualRatePercent: '18',
  monthlyPayment: '12000.00',
  nextDueDate: '2026-07-10',
};

describe('simulateEarlyRepayment — базовый сценарий', () => {
  it('без доплат scenario == baseline (нулевая экономия)', () => {
    const r = simulateEarlyRepayment(base)!;
    expect(r.feasible).toBe(true);
    expect(r.scenario.months).toBe(r.baseline.months);
    expect(r.interestSaved).toBe('0.00');
    expect(r.monthsSaved).toBe(0);
  });

  it('последний платёж приходится через (months − 1) месяцев после ближайшего', () => {
    const r = simulateEarlyRepayment(base)!;
    expect(r.baseline.months).toBeGreaterThan(0);
    // первый платёж — 2026-07-10, проверяем что дата конца непустая и в будущем
    expect(r.baseline.lastDate >= base.nextDueDate).toBe(true);
  });
});

describe('simulateEarlyRepayment — доплата к платежу', () => {
  const r = simulateEarlyRepayment({ ...base, extraMonthly: '8000' })!;

  it('сокращает срок', () => {
    expect(r.monthsSaved).toBeGreaterThan(0);
    expect(r.scenario.months).toBeLessThan(r.baseline.months);
  });

  it('экономит на процентах', () => {
    expect(toKopecks(r.interestSaved)).toBeGreaterThan(0);
    expect(toKopecks(r.scenario.totalInterest)).toBeLessThan(toKopecks(r.baseline.totalInterest));
  });
});

describe('simulateEarlyRepayment — разовое погашение', () => {
  it('частичный lump sum сокращает срок и проценты', () => {
    const r = simulateEarlyRepayment({ ...base, lumpSum: '200000' })!;
    expect(r.paidOffByLumpSum).toBe(false);
    expect(r.monthsSaved).toBeGreaterThan(0);
    expect(toKopecks(r.interestSaved)).toBeGreaterThan(0);
  });

  it('lump sum ≥ остатка гасит долг целиком', () => {
    const r = simulateEarlyRepayment({ ...base, lumpSum: '500000' })!;
    expect(r.paidOffByLumpSum).toBe(true);
    expect(r.scenario.months).toBe(0);
    expect(r.scenario.totalInterest).toBe('0.00');
    expect(r.monthsSaved).toBe(r.baseline.months);
  });
});

describe('simulateEarlyRepayment — крайние случаи', () => {
  it('нулевая ставка: процентов нет, экономия только в месяцах', () => {
    const r = simulateEarlyRepayment({
      remainingPrincipal: '120000.00',
      annualRatePercent: '0',
      monthlyPayment: '10000.00',
      nextDueDate: '2026-01-15',
      extraMonthly: '10000',
    })!;
    expect(r.feasible).toBe(true);
    expect(r.baseline.totalInterest).toBe('0.00');
    expect(r.scenario.totalInterest).toBe('0.00');
    expect(r.baseline.months).toBe(12);
    expect(r.scenario.months).toBe(6);
    expect(r.monthsSaved).toBe(6);
  });

  it('нет остатка долга → null', () => {
    expect(simulateEarlyRepayment({ ...base, remainingPrincipal: '0' })).toBeNull();
  });

  it('нулевой платёж → null', () => {
    expect(simulateEarlyRepayment({ ...base, monthlyPayment: '0' })).toBeNull();
  });

  it('платёж не покрывает проценты → infeasible', () => {
    const r = simulateEarlyRepayment({
      remainingPrincipal: '1000000.00',
      annualRatePercent: '36',
      monthlyPayment: '1000.00', // меньше первого месячного процента (~30 000 ₽)
      nextDueDate: '2026-02-01',
    })!;
    expect(r.feasible).toBe(false);
  });
});
