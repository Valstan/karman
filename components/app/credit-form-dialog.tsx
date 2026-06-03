'use client';

import { useState, type ReactNode } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createCreditAction, updateCreditAction } from '@/lib/actions/credits';
import { PAYMENT_TYPE_LABELS, CREDIT_STATUS_LABELS } from '@/lib/constants';
import { todayStr } from '@/lib/dates';
import type { CreditListItem } from '@/lib/services/credits';
import type { CreditStatus, PaymentType } from '@/lib/db/schema';

type BankOption = { id: number; name: string };

type FormValues = {
  name: string;
  bankId: string;
  amount: string;
  interestRate: string;
  monthlyPayment: string;
  termMonths: string;
  startDate: string;
  paymentType: PaymentType;
  status: CreditStatus;
  description: string;
  generateSchedule: boolean;
};

function defaults(credit?: CreditListItem): FormValues {
  return {
    name: credit?.rawName ?? '',
    bankId: credit ? String(credit.bankId) : '',
    amount: credit?.amount ?? '',
    interestRate: credit?.interestRate ?? '',
    monthlyPayment: credit?.monthlyPayment ?? '',
    termMonths: credit ? String(credit.termMonths) : '12',
    startDate: credit?.startDate ?? todayStr(),
    paymentType: credit?.paymentType ?? 'annuity',
    status: credit?.status ?? 'active',
    description: credit?.description ?? '',
    generateSchedule: true,
  };
}

export function CreditFormDialog({
  trigger,
  banks,
  credit,
}: {
  trigger: ReactNode;
  banks: BankOption[];
  credit?: CreditListItem;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const isEdit = Boolean(credit);

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { isSubmitting },
  } = useForm<FormValues>({ defaultValues: defaults(credit) });

  async function onSubmit(values: FormValues) {
    if (!values.bankId) {
      toast.error('Выберите банк');
      return;
    }

    const result = isEdit
      ? await updateCreditAction({ id: credit!.id, ...values })
      : await createCreditAction(values);

    if (!result.ok) {
      toast.error(result.error);
      return;
    }

    toast.success(isEdit ? 'Кредит обновлён' : 'Кредит создан');
    setOpen(false);
    reset(defaults(isEdit ? credit : undefined));
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset(defaults(credit));
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Редактировать кредит' : 'Новый кредит'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Измените параметры кредита.'
              : 'Заполните параметры. График платежей создастся автоматически.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="name">Название</Label>
            <Input id="name" placeholder="Напр. Потребительский" {...register('name')} />
          </div>

          <div className="grid gap-2">
            <Label>Банк</Label>
            <Controller
              control={control}
              name="bankId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Выберите банк" />
                  </SelectTrigger>
                  <SelectContent>
                    {banks.map((bank) => (
                      <SelectItem key={bank.id} value={String(bank.id)}>
                        {bank.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="amount">Сумма, ₽</Label>
              <Input id="amount" inputMode="decimal" {...register('amount')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="interestRate">Ставка, %</Label>
              <Input id="interestRate" inputMode="decimal" {...register('interestRate')} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="termMonths">Срок, мес.</Label>
              <Input id="termMonths" inputMode="numeric" {...register('termMonths')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="startDate">Дата выдачи</Label>
              <Input id="startDate" type="date" {...register('startDate')} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Тип платежей</Label>
              <Controller
                control={control}
                name="paymentType"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(PAYMENT_TYPE_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
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
                      {Object.entries(CREDIT_STATUS_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="monthlyPayment">
              Ежемесячный платёж, ₽ <span className="text-muted-foreground">(для типа «Другой»)</span>
            </Label>
            <Input id="monthlyPayment" inputMode="decimal" {...register('monthlyPayment')} />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="description">Описание</Label>
            <Textarea id="description" rows={2} {...register('description')} />
          </div>

          {!isEdit && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4" {...register('generateSchedule')} />
              Сгенерировать график платежей автоматически
            </label>
          )}

          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Сохранение…' : isEdit ? 'Сохранить' : 'Создать'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
