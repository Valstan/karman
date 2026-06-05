'use client';

import { useMemo, useState } from 'react';
import { TrendingDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDate, formatMoney } from '@/lib/format';
import { simulateEarlyRepayment } from '@/lib/services/early-repayment';

/** «12 мес.» → «1 год 0 мес.» */
function formatMonths(total: number): string {
  if (total <= 0) return '0 мес.';
  const years = Math.floor(total / 12);
  const months = total % 12;
  const parts: string[] = [];
  if (years > 0) {
    const yLabel = years % 10 === 1 && years % 100 !== 11 ? 'год' : years % 10 >= 2 && years % 10 <= 4 && (years % 100 < 10 || years % 100 >= 20) ? 'года' : 'лет';
    parts.push(`${years} ${yLabel}`);
  }
  parts.push(`${months} мес.`);
  return parts.join(' ');
}

/** Оставляем только цифры, точку/запятую — мягкая нормализация ввода денег. */
function sanitizeMoney(raw: string): string {
  return raw.replace(/[^\d.,]/g, '');
}

export function EarlyRepaymentCalculator({
  remainingPrincipal,
  annualRatePercent,
  monthlyPayment,
  nextDueDate,
}: {
  remainingPrincipal: string;
  annualRatePercent: string;
  monthlyPayment: string;
  nextDueDate: string;
}) {
  const [extraMonthly, setExtraMonthly] = useState('');
  const [lumpSum, setLumpSum] = useState('');

  const result = useMemo(
    () =>
      simulateEarlyRepayment({
        remainingPrincipal,
        annualRatePercent,
        monthlyPayment,
        nextDueDate,
        extraMonthly: extraMonthly || null,
        lumpSum: lumpSum || null,
      }),
    [remainingPrincipal, annualRatePercent, monthlyPayment, nextDueDate, extraMonthly, lumpSum],
  );

  if (!result) return null;

  const hasScenario = Boolean(extraMonthly || lumpSum);
  const { baseline, scenario } = result;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingDown className="h-4 w-4" />
          Калькулятор досрочного погашения
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <p className="text-sm text-muted-foreground">
          Модель остатка долга {formatMoney(remainingPrincipal)} как аннуитета с фиксированным
          платежом. Реальный график не меняется — это прогноз «что если».
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="extra-monthly">Доплата к ежемесячному платежу, ₽</Label>
            <Input
              id="extra-monthly"
              inputMode="decimal"
              placeholder="0"
              value={extraMonthly}
              onChange={(e) => setExtraMonthly(sanitizeMoney(e.target.value))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="lump-sum">Разовое погашение сейчас, ₽</Label>
            <Input
              id="lump-sum"
              inputMode="decimal"
              placeholder="0"
              value={lumpSum}
              onChange={(e) => setLumpSum(sanitizeMoney(e.target.value))}
            />
          </div>
        </div>

        {!result.feasible ? (
          <p className="text-sm text-destructive">
            Текущий платёж не покрывает начисляемые проценты — расчёт невозможен.
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">Сейчас</div>
                <div className="mt-1 font-medium">{formatMonths(baseline.months)}</div>
                <div className="text-xs text-muted-foreground">
                  проценты: {formatMoney(baseline.totalInterest)}
                  {baseline.lastDate ? ` · до ${formatDate(baseline.lastDate)}` : ''}
                </div>
              </div>
              <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
                <div className="text-xs text-muted-foreground">
                  {hasScenario ? 'С досрочным погашением' : 'Введите доплату выше'}
                </div>
                <div className="mt-1 font-medium">
                  {scenario.months === 0 && hasScenario ? 'Долг погашен' : formatMonths(scenario.months)}
                </div>
                <div className="text-xs text-muted-foreground">
                  проценты: {formatMoney(scenario.totalInterest)}
                  {scenario.lastDate ? ` · до ${formatDate(scenario.lastDate)}` : ''}
                </div>
              </div>
            </div>

            {hasScenario && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg bg-muted/50 p-3 text-center">
                  <div className="text-xs text-muted-foreground">Экономия на процентах</div>
                  <div className="mt-1 text-xl font-semibold text-emerald-600 dark:text-emerald-500">
                    {formatMoney(result.interestSaved)}
                  </div>
                </div>
                <div className="rounded-lg bg-muted/50 p-3 text-center">
                  <div className="text-xs text-muted-foreground">Срок короче на</div>
                  <div className="mt-1 text-xl font-semibold">
                    {result.paidOffByLumpSum
                      ? formatMonths(baseline.months)
                      : formatMonths(result.monthsSaved)}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
