'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, ExternalLink, Pencil, Trash2 } from 'lucide-react';
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
import type { PaymentListItem } from '@/lib/services/payments';

export function AllPaymentsTable({ payments }: { payments: PaymentListItem[] }) {
  const router = useRouter();

  async function markPaid(payment: PaymentListItem) {
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
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Кредит</TableHead>
            <TableHead>Банк</TableHead>
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
              <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                Платежей нет. Добавьте их на странице{' '}
                <Link href="/credits" className="underline underline-offset-2">
                  кредита
                </Link>
                .
              </TableCell>
            </TableRow>
          )}
          {payments.map((payment) => (
            <TableRow key={payment.id}>
              <TableCell className="font-medium">
                <Link
                  href={`/credits/${payment.creditId}`}
                  className="hover:underline underline-offset-2"
                >
                  {payment.creditName}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{payment.bankName}</TableCell>
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
                    creditId={payment.creditId}
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
                  <Button size="icon" variant="ghost" title="Открыть кредит" asChild>
                    <Link href={`/credits/${payment.creditId}`}>
                      <ExternalLink className="h-4 w-4" />
                    </Link>
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
