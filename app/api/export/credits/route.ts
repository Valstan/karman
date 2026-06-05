import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { listCredits } from '@/lib/services/credits';
import { buildCsv, csvDate, csvMoney } from '@/lib/csv';
import { creditStatusLabel, paymentTypeLabel } from '@/lib/constants';
import { todayStr } from '@/lib/dates';
import { csvResponse } from '../csv-response';

export const runtime = 'nodejs';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ message: 'Требуется авторизация' }, { status: 401 });

  const credits = await listCredits(user);
  const headers = [
    'Название',
    'Банк',
    'Сумма',
    'Ставка, %',
    'Срок, мес.',
    'Тип платежей',
    'Дата выдачи',
    'Статус',
    'Ежемес. платёж',
  ];
  const rows = credits.map((c) => [
    c.name,
    c.bankName,
    csvMoney(c.amount),
    csvMoney(c.interestRate),
    c.termMonths,
    paymentTypeLabel(c.paymentType),
    csvDate(c.startDate),
    creditStatusLabel(c.status),
    csvMoney(c.monthlyPayment),
  ]);

  return csvResponse(`credits-${todayStr()}.csv`, buildCsv(headers, rows));
}
