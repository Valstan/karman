import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireUser } from '@/lib/auth/current-user';
import { getCreditDetail } from '@/lib/services/credits';
import { listBanks } from '@/lib/services/banks';
import { CreditActions } from '@/components/app/credit-actions';
import { PaymentScheduleTable } from '@/components/app/payment-schedule-table';
import { EarlyRepaymentCalculator } from '@/components/app/early-repayment-calculator';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate, formatMoney, formatPercent } from '@/lib/format';
import { fromKopecks, toKopecks } from '@/lib/money';
import { creditStatusLabel, creditStatusVariant, paymentTypeLabel } from '@/lib/constants';

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

export default async function CreditDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const creditId = Number(id);
  const user = await requireUser();

  if (!Number.isInteger(creditId)) {
    notFound();
  }

  const [detail, banks] = await Promise.all([
    getCreditDetail(user, creditId),
    listBanks(user),
  ]);

  if (!detail) {
    notFound();
  }

  const bankOptions = banks.map((b) => ({ id: b.id, name: b.name }));

  // Данные для калькулятора досрочного погашения: остаток тела = Σ principal по
  // неоплаченным платежам, ближайший платёж задаёт текущий взнос и дату старта.
  const unpaid = detail.payments.filter((p) => p.status !== 'paid');
  const remainingPrincipal = fromKopecks(
    unpaid.reduce((acc, p) => acc + toKopecks(p.principalAmount ?? '0'), 0),
  );
  const nextPayment = unpaid[0];
  const showCalculator = Boolean(nextPayment) && toKopecks(remainingPrincipal) > 0;

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/credits"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-1 h-4 w-4" /> К списку кредитов
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{detail.name}</h1>
            <Badge variant={creditStatusVariant(detail.status)}>
              {creditStatusLabel(detail.status)}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">{detail.bankName}</p>
        </div>
        <CreditActions credit={detail} banks={bankOptions} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Параметры</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Info label="Сумма" value={formatMoney(detail.amount)} />
              <Info label="Ставка" value={formatPercent(detail.interestRate)} />
              <Info label="Срок" value={`${detail.termMonths} мес.`} />
              <Info label="Тип платежей" value={paymentTypeLabel(detail.paymentType)} />
              <Info label="Дата выдачи" value={formatDate(detail.startDate)} />
              <Info label="Ежемес. платёж" value={formatMoney(detail.monthlyPayment)} />
            </dl>
            {detail.description && (
              <p className="mt-4 text-sm text-muted-foreground">{detail.description}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Прогресс</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4">
              <Info label="Оплачено" value={formatMoney(detail.aggregates.paidAmount)} />
              <Info label="Остаток" value={formatMoney(detail.aggregates.remainingAmount)} />
              <Info
                label="Платежей"
                value={`${detail.aggregates.paymentsPaid}/${detail.aggregates.paymentsTotal}`}
              />
              <Info label="Просрочено" value={String(detail.aggregates.paymentsOverdue)} />
            </dl>
          </CardContent>
        </Card>
      </div>

      {showCalculator && nextPayment && (
        <EarlyRepaymentCalculator
          remainingPrincipal={remainingPrincipal}
          annualRatePercent={detail.interestRate}
          monthlyPayment={nextPayment.amount}
          nextDueDate={nextPayment.dueDate}
        />
      )}

      <PaymentScheduleTable creditId={detail.id} payments={detail.payments} />
    </div>
  );
}
