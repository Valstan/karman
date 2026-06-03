'use client';

import { useRouter } from 'next/navigation';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PaymentFormDialog } from './payment-form-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { deletePaymentAction, updatePaymentAction } from '@/lib/actions/payments';
import { formatDate, formatMoney } from '@/lib/format';
import { paymentStatusLabel, paymentStatusVariant } from '@/lib/constants';
import { todayStr } from '@/lib/dates';
import type { CreditPayment } from '@/lib/services/credits';

export function PaymentScheduleTable({
  creditId,
  payments,
}: {
  creditId: number;
  payments: CreditPayment[];
}) {
  const router = useRouter();

  async function markPaid(payment: CreditPayment) {
    const result = await updatePaymentAction({
      id: payment.id,
      status: 'paid',
      paidDate: payment.paidDate ?? todayStr(),
    });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Платёж отмечен оплаченным');
    router.refresh();
  }

  async function remove(id: number) {
    const result = await deletePaymentAction(id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Платёж удалён');
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">График платежей</h2>
        <PaymentFormDialog
          creditId={creditId}
          trigger={
            <Button size="sm" variant="outline">
              <Plus className="mr-1 h-4 w-4" /> Платёж
            </Button>
          }
        />
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Дата</TableHead>
              <TableHead className="text-right">Сумма</TableHead>
              <TableHead className="text-right">Тело</TableHead>
              <TableHead className="text-right">Проценты</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead className="text-right">Действия</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payments.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  Платежей нет. Добавьте вручную или перегенерируйте график.
                </TableCell>
              </TableRow>
            )}
            {payments.map((payment) => (
              <TableRow key={payment.id}>
                <TableCell>{formatDate(payment.dueDate)}</TableCell>
                <TableCell className="text-right font-medium">
                  {formatMoney(payment.amount)}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {formatMoney(payment.principalAmount)}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {formatMoney(payment.interestAmount)}
                </TableCell>
                <TableCell>
                  <Badge variant={paymentStatusVariant(payment.status)}>
                    {paymentStatusLabel(payment.status)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    {payment.status !== 'paid' && (
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Отметить оплаченным"
                        onClick={() => markPaid(payment)}
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                    )}
                    <PaymentFormDialog
                      creditId={creditId}
                      payment={payment}
                      trigger={
                        <Button size="icon" variant="ghost" title="Редактировать">
                          <Pencil className="h-4 w-4" />
                        </Button>
                      }
                    />
                    <ConfirmDialog
                      title="Удалить платёж?"
                      description="Действие необратимо."
                      onConfirm={() => remove(payment.id)}
                      trigger={
                        <Button size="icon" variant="ghost" title="Удалить">
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      }
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
