import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getCreditDetail } from '@/lib/services/credits';
import { buildCsv, csvDate, csvMoney } from '@/lib/csv';
import { paymentStatusLabel } from '@/lib/constants';
import { todayStr } from '@/lib/dates';
import { csvResponse } from '../../../csv-response';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ message: 'Требуется авторизация' }, { status: 401 });

  const { id } = await ctx.params;
  const creditId = Number(id);
  if (!Number.isInteger(creditId) || creditId <= 0) {
    return NextResponse.json({ message: 'Некорректный запрос' }, { status: 400 });
  }

  const detail = await getCreditDetail(user, creditId);
  if (!detail) return NextResponse.json({ message: 'Кредит не найден' }, { status: 404 });

  const headers = ['№', 'Срок оплаты', 'Сумма', 'Тело', 'Проценты', 'Статус', 'Дата оплаты'];
  const rows = detail.payments.map((p, i) => [
    i + 1,
    csvDate(p.dueDate),
    csvMoney(p.amount),
    csvMoney(p.principalAmount),
    csvMoney(p.interestAmount),
    paymentStatusLabel(p.status),
    csvDate(p.paidDate),
  ]);

  return csvResponse(`credit-${creditId}-payments-${todayStr()}.csv`, buildCsv(headers, rows));
}
