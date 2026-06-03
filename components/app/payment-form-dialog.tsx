'use client';

import { useState, type ReactNode } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createPaymentAction, updatePaymentAction } from '@/lib/actions/payments';
import { PAYMENT_STATUS_LABELS } from '@/lib/constants';
import { todayStr } from '@/lib/dates';
import type { CreditPayment } from '@/lib/services/credits';
import type { PaymentStatus } from '@/lib/db/schema';

type FormValues = {
  amount: string;
  principalAmount: string;
  interestAmount: string;
  dueDate: string;
  paidDate: string;
  status: PaymentStatus;
};

function defaults(payment?: CreditPayment): FormValues {
  return {
    amount: payment?.amount ?? '',
    principalAmount: payment?.principalAmount ?? '',
    interestAmount: payment?.interestAmount ?? '',
    dueDate: payment?.dueDate ?? todayStr(),
    paidDate: payment?.paidDate ?? '',
    status: payment?.status ?? 'scheduled',
  };
}

export function PaymentFormDialog({
  trigger,
  creditId,
  payment,
}: {
  trigger: ReactNode;
  creditId: number;
  payment?: CreditPayment;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const isEdit = Boolean(payment);

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { isSubmitting },
  } = useForm<FormValues>({ defaultValues: defaults(payment) });

  async function onSubmit(values: FormValues) {
    const result = isEdit
      ? await updatePaymentAction({ id: payment!.id, ...values })
      : await createPaymentAction({ creditId, ...values });

    if (!result.ok) {
      toast.error(result.error);
      return;
    }

    toast.success(isEdit ? 'Платёж обновлён' : 'Платёж добавлен');
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset(defaults(payment));
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Редактировать платёж' : 'Новый платёж'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="amount">Сумма, ₽</Label>
            <Input id="amount" inputMode="decimal" {...register('amount')} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="principalAmount">Тело, ₽</Label>
              <Input id="principalAmount" inputMode="decimal" {...register('principalAmount')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="interestAmount">Проценты, ₽</Label>
              <Input id="interestAmount" inputMode="decimal" {...register('interestAmount')} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="dueDate">Дата платежа</Label>
              <Input id="dueDate" type="date" {...register('dueDate')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="paidDate">Дата оплаты</Label>
              <Input id="paidDate" type="date" {...register('paidDate')} />
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Статус</Label>
            <Controller
              control={control}
              name="status"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(PAYMENT_STATUS_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Сохранение…' : isEdit ? 'Сохранить' : 'Добавить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
