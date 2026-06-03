import { addMonths } from '@/lib/dates';
import { fromKopecks, toKopecks } from '@/lib/money';
import type { PaymentType } from '@/lib/db/schema';

export type ScheduleRow = {
  dueDate: string;
  amount: string;
  principalAmount: string | null;
  interestAmount: string | null;
  status: 'scheduled';
};

export type GenerateScheduleParams = {
  amount: string; // тело кредита
  annualRatePercent: string; // годовая ставка, %
  termMonths: number;
  startDate: string; // дата выдачи; первый платёж — через месяц
  paymentType: PaymentType;
  monthlyPayment?: string | null;
};

/**
 * Чистая функция генерации графика платежей.
 * Вся арифметика — в копейках (целые), последний платёж добирает округление,
 * так что Σprincipal == amount ровно.
 */
export function generateSchedule(params: GenerateScheduleParams): ScheduleRow[] {
  const { amount, annualRatePercent, termMonths, startDate, paymentType, monthlyPayment } = params;
  const n = Math.trunc(termMonths);
  if (n < 1) {
    return [];
  }

  const principal = toKopecks(amount);
  if (principal <= 0) {
    return [];
  }

  const monthlyRate = Number(String(annualRatePercent).replace(',', '.')) / 100 / 12;

  if (paymentType === 'other') {
    if (!monthlyPayment) {
      return [];
    }
    const pay = fromKopecks(toKopecks(monthlyPayment));
    return Array.from({ length: n }, (_, k) => ({
      dueDate: addMonths(startDate, k + 1),
      amount: pay,
      principalAmount: null,
      interestAmount: null,
      status: 'scheduled' as const,
    }));
  }

  if (paymentType === 'differentiated') {
    return generateDifferentiated(principal, monthlyRate, n, startDate);
  }

  return generateAnnuity(principal, monthlyRate, n, startDate);
}

function generateAnnuity(
  principal: number,
  i: number,
  n: number,
  startDate: string,
): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  let balance = principal;

  // Размер аннуитетного платежа (копейки). При нулевой ставке — равные доли тела.
  const annuity = i === 0 ? Math.round(principal / n) : Math.round((principal * i) / (1 - Math.pow(1 + i, -n)));

  for (let m = 1; m <= n; m += 1) {
    const interest = i === 0 ? 0 : Math.round(balance * i);
    let principalPart = annuity - interest;
    let payment = annuity;

    if (m === n) {
      // Последний платёж гасит остаток полностью.
      principalPart = balance;
      payment = principalPart + interest;
    }

    balance -= principalPart;

    rows.push({
      dueDate: addMonths(startDate, m),
      amount: fromKopecks(payment),
      principalAmount: fromKopecks(principalPart),
      interestAmount: fromKopecks(interest),
      status: 'scheduled',
    });
  }

  return rows;
}

function generateDifferentiated(
  principal: number,
  i: number,
  n: number,
  startDate: string,
): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  let balance = principal;
  const basePrincipal = Math.floor(principal / n);

  for (let m = 1; m <= n; m += 1) {
    const interest = i === 0 ? 0 : Math.round(balance * i);
    const principalPart = m === n ? balance : basePrincipal;
    balance -= principalPart;

    rows.push({
      dueDate: addMonths(startDate, m),
      amount: fromKopecks(principalPart + interest),
      principalAmount: fromKopecks(principalPart),
      interestAmount: fromKopecks(interest),
      status: 'scheduled',
    });
  }

  return rows;
}
