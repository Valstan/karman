import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { getDashboard } from '@/lib/services/dashboard';
import { DashboardCharts } from '@/components/app/dashboard-charts';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate, formatMoney } from '@/lib/format';
import {
  creditStatusLabel,
  creditStatusVariant,
  paymentStatusLabel,
  paymentStatusVariant,
  documentExpiryBadge,
} from '@/lib/constants';

function StatCard({ title, value, hint }: { title: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export default async function DashboardPage() {
  const user = await requireUser();
  const data = await getDashboard(user);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Панель</h1>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Кредитов"
          value={String(data.creditsByStatus.total)}
          hint={`Активных: ${data.creditsByStatus.active} · Просрочено: ${data.creditsByStatus.overdue}`}
        />
        <StatCard title="Оплачено" value={formatMoney(data.payments.paidAmount)} />
        <StatCard title="Остаток к оплате" value={formatMoney(data.payments.remainingAmount)} />
        <StatCard
          title="Платежей"
          value={String(data.payments.total)}
          hint={`Просрочено: ${data.payments.overdue} · Оплачено: ${data.payments.paid}`}
        />
      </div>

      <DashboardCharts creditsByStatus={data.creditsByStatus} perBank={data.perBank} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Активные кредиты</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {data.activeCredits.length === 0 && (
              <p className="text-sm text-muted-foreground">Активных кредитов нет.</p>
            )}
            {data.activeCredits.map((credit) => (
              <Link
                key={credit.id}
                href={`/credits/${credit.id}`}
                className="flex items-center justify-between rounded-lg border p-3 transition-colors hover:bg-accent"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{credit.name}</span>
                    <Badge variant={creditStatusVariant(credit.status)}>
                      {creditStatusLabel(credit.status)}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {credit.bankName} · {credit.paymentsPaid}/{credit.paymentsTotal} платежей
                    {credit.nextPayment
                      ? ` · след. ${formatDate(credit.nextPayment.dueDate)}`
                      : ''}
                  </p>
                </div>
                <div className="ml-3 shrink-0 text-right">
                  <div className="text-sm font-semibold">{formatMoney(credit.remainingAmount)}</div>
                  <div className="text-xs text-muted-foreground">остаток</div>
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ближайшие платежи (30 дней)</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {data.upcomingPayments.length === 0 && (
              <p className="text-sm text-muted-foreground">Платежей в ближайшие 30 дней нет.</p>
            )}
            {data.upcomingPayments.map((payment) => (
              <Link
                key={payment.id}
                href={`/credits/${payment.creditId}`}
                className="flex items-center justify-between rounded-md border p-2.5 transition-colors hover:bg-accent"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{payment.creditName}</div>
                  <div className="text-xs text-muted-foreground">{formatDate(payment.dueDate)}</div>
                </div>
                <div className="ml-3 flex shrink-0 items-center gap-2">
                  <span className="text-sm font-semibold">{formatMoney(payment.amount)}</span>
                  <Badge variant={paymentStatusVariant(payment.status)}>
                    {paymentStatusLabel(payment.status)}
                  </Badge>
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Документы — истекающий срок (30 дней)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {data.expiringDocuments.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Документов с истекающим сроком нет.
            </p>
          )}
          {data.expiringDocuments.map((doc) => {
            const badge = documentExpiryBadge(doc.expiryDate);
            return (
              <Link
                key={doc.id}
                href="/documents"
                className="flex items-center justify-between rounded-md border p-2.5 transition-colors hover:bg-accent"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{doc.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {doc.documentType ? `${doc.documentType} · ` : ''}до {formatDate(doc.expiryDate)}
                  </div>
                </div>
                {badge && (
                  <Badge variant={badge.variant} className="ml-3 shrink-0">
                    {badge.label}
                  </Badge>
                )}
              </Link>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
