import { describe, it, expect } from 'vitest';
import { generateSchedule } from './schedule';
import { toKopecks } from '@/lib/money';

function sumPrincipalKopecks(rows: { principalAmount: string | null }[]): number {
  return rows.reduce((acc, r) => acc + (r.principalAmount ? toKopecks(r.principalAmount) : 0), 0);
}

describe('generateSchedule — аннуитет', () => {
  const rows = generateSchedule({
    amount: '300000.00',
    annualRatePercent: '18.5',
    termMonths: 36,
    startDate: '2026-01-15',
    paymentType: 'annuity',
  });

  it('создаёт ровно termMonths строк', () => {
    expect(rows).toHaveLength(36);
  });

  it('сумма тел равна сумме кредита (округление сходится в ноль)', () => {
    expect(sumPrincipalKopecks(rows)).toBe(toKopecks('300000.00'));
  });

  it('первый платёж — через месяц после выдачи', () => {
    expect(rows[0]!.dueDate).toBe('2026-02-15');
    expect(rows.at(-1)!.dueDate).toBe('2029-01-15');
  });

  it('amount = principal + interest в каждой строке', () => {
    for (const r of rows) {
      expect(toKopecks(r.amount)).toBe(toKopecks(r.principalAmount!) + toKopecks(r.interestAmount!));
    }
  });
});

describe('generateSchedule — дифференцированный', () => {
  const rows = generateSchedule({
    amount: '600000.00',
    annualRatePercent: '14',
    termMonths: 24,
    startDate: '2026-05-10',
    paymentType: 'differentiated',
  });

  it('сумма тел равна сумме кредита', () => {
    expect(sumPrincipalKopecks(rows)).toBe(toKopecks('600000.00'));
  });

  it('платежи убывают (тело постоянно, проценты падают)', () => {
    expect(toKopecks(rows[0]!.amount)).toBeGreaterThan(toKopecks(rows.at(-1)!.amount));
  });
});

describe('generateSchedule — крайние случаи', () => {
  it('нулевая ставка: только тело, проценты ноль', () => {
    const rows = generateSchedule({
      amount: '120000.00',
      annualRatePercent: '0',
      termMonths: 12,
      startDate: '2026-01-31',
      paymentType: 'annuity',
    });
    expect(sumPrincipalKopecks(rows)).toBe(toKopecks('120000.00'));
    expect(rows.every((r) => toKopecks(r.interestAmount!) === 0)).toBe(true);
    // клампинг конца месяца: 31 янв → 28/29 фев
    expect(rows[0]!.dueDate).toBe('2026-02-28');
  });

  it('n=1: единственный платёж гасит всё', () => {
    const rows = generateSchedule({
      amount: '50000.00',
      annualRatePercent: '10',
      termMonths: 1,
      startDate: '2026-03-01',
      paymentType: 'annuity',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.principalAmount).toBe('50000.00');
  });

  it("'other' без monthlyPayment — пустой график", () => {
    expect(
      generateSchedule({
        amount: '50000.00',
        annualRatePercent: '10',
        termMonths: 6,
        startDate: '2026-03-01',
        paymentType: 'other',
      }),
    ).toHaveLength(0);
  });

  it("'other' с monthlyPayment — равные платежи без разбивки", () => {
    const rows = generateSchedule({
      amount: '50000.00',
      annualRatePercent: '10',
      termMonths: 6,
      startDate: '2026-03-01',
      paymentType: 'other',
      monthlyPayment: '9000',
    });
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.amount === '9000.00' && r.principalAmount === null)).toBe(true);
  });
});
