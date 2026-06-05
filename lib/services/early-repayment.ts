import { addMonths } from '@/lib/dates';
import { fromKopecks, toKopecks } from '@/lib/money';

/**
 * Калькулятор досрочного погашения («что если»).
 *
 * Чистая функция, без обращения к БД и без `server-only` — считается и на сервере,
 * и на клиенте. Остаток долга моделируется как аннуитет с фиксированным ежемесячным
 * платежом: вся арифметика в копейках (целые), проценты начисляются на текущий остаток.
 * НИЧЕГО не пишет — реальный график платежей не меняется.
 */

export type EarlyRepaymentInput = {
  /** Остаток основного долга (тело), руб. */
  remainingPrincipal: string;
  /** Годовая ставка, %. */
  annualRatePercent: string;
  /** Текущий ежемесячный платёж, руб. */
  monthlyPayment: string;
  /** Дата ближайшего платежа `YYYY-MM-DD`. */
  nextDueDate: string;
  /** Сценарий: доплата к ежемесячному платежу, руб. */
  extraMonthly?: string | null;
  /** Сценарий: разовое погашение «сейчас», руб. */
  lumpSum?: string | null;
};

export type RepaymentPlan = {
  /** Сколько платежей осталось. */
  months: number;
  /** Сумма процентов за весь остаток срока, руб. */
  totalInterest: string;
  /** Дата последнего платежа `YYYY-MM-DD` (пусто, если долг уже погашен). */
  lastDate: string;
};

export type EarlyRepaymentResult = {
  /** Платёж покрывает проценты и долг гасится за конечное число месяцев. */
  feasible: boolean;
  /** Базовый сценарий — текущие условия без доплат. */
  baseline: RepaymentPlan;
  /** Сценарий с досрочным погашением. */
  scenario: RepaymentPlan;
  /** Экономия на процентах (baseline − scenario), руб. */
  interestSaved: string;
  /** На сколько месяцев короче (baseline − scenario). */
  monthsSaved: number;
  /** Разовый платёж погасил весь остаток. */
  paidOffByLumpSum: boolean;
};

const MAX_MONTHS = 1200; // предохранитель от бесконечного цикла (100 лет)

type AmortResult = { months: number; interestKopecks: number; lastDate: string; feasible: boolean };

/**
 * Прогон амортизации: гасим `balance` фиксированным платежом `payment` при месячной
 * ставке `i`, пока остаток не обнулится. Последний платёж добирает остаток.
 */
function amortize(balance: number, i: number, payment: number, nextDueDate: string): AmortResult {
  if (balance <= 0) {
    return { months: 0, interestKopecks: 0, lastDate: '', feasible: true };
  }
  let interestTotal = 0;
  let months = 0;
  let lastDate = '';

  while (balance > 0 && months < MAX_MONTHS) {
    const interest = i > 0 ? Math.round(balance * i) : 0;
    let principalPart = payment - interest;
    if (principalPart <= 0) {
      // Платёж не покрывает проценты — долг не гасится никогда.
      return { months: Infinity, interestKopecks: Infinity, lastDate: '', feasible: false };
    }
    if (principalPart > balance) {
      principalPart = balance;
    }
    balance -= principalPart;
    interestTotal += interest;
    months += 1;
    lastDate = addMonths(nextDueDate, months - 1);
  }

  return { months, interestKopecks: interestTotal, lastDate, feasible: balance <= 0 };
}

function toPlan(a: AmortResult): RepaymentPlan {
  return {
    months: a.feasible ? a.months : 0,
    totalInterest: a.feasible ? fromKopecks(a.interestKopecks) : '0.00',
    lastDate: a.lastDate,
  };
}

/**
 * Считает экономию от досрочного погашения. Возвращает `null`, если входные данные
 * не позволяют построить модель (нет остатка долга или нулевой платёж).
 */
export function simulateEarlyRepayment(input: EarlyRepaymentInput): EarlyRepaymentResult | null {
  const principal = toKopecks(input.remainingPrincipal);
  const basePayment = toKopecks(input.monthlyPayment);
  if (principal <= 0 || basePayment <= 0) {
    return null;
  }

  const i = Number(String(input.annualRatePercent).replace(',', '.')) / 100 / 12;
  const extra = input.extraMonthly ? Math.max(0, toKopecks(input.extraMonthly)) : 0;
  const lump = input.lumpSum ? Math.max(0, toKopecks(input.lumpSum)) : 0;

  const baseline = amortize(principal, i, basePayment, input.nextDueDate);

  const scenarioBalance = Math.max(0, principal - lump);
  const paidOffByLumpSum = scenarioBalance === 0;
  const scenario: AmortResult = paidOffByLumpSum
    ? { months: 0, interestKopecks: 0, lastDate: '', feasible: true }
    : amortize(scenarioBalance, i, basePayment + extra, input.nextDueDate);

  const feasible = baseline.feasible && scenario.feasible;

  const interestSavedKopecks = feasible ? baseline.interestKopecks - scenario.interestKopecks : 0;
  const monthsSaved = feasible ? baseline.months - scenario.months : 0;

  return {
    feasible,
    baseline: toPlan(baseline),
    scenario: toPlan(scenario),
    interestSaved: fromKopecks(Math.max(0, interestSavedKopecks)),
    monthsSaved: Math.max(0, monthsSaved),
    paidOffByLumpSum,
  };
}
