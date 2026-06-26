import { requireUser } from '@/lib/auth/current-user';
import { listPayments } from '@/lib/services/payments';
import { AllPaymentsTable } from '@/components/app/all-payments-table';

export default async function PaymentsPage() {
  const user = await requireUser();
  const payments = await listPayments(user);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Платежи</h1>
        <p className="text-sm text-muted-foreground">Все платежи по всем кредитам</p>
      </div>
      <AllPaymentsTable payments={payments} />
    </div>
  );
}
