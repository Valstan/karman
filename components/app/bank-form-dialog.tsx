'use client';

import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
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
import { createBankAction, updateBankAction } from '@/lib/actions/banks';
import type { BankListItem } from '@/lib/services/banks';

type FormValues = {
  name: string;
  phone: string;
  website: string;
  email: string;
  address: string;
};

function defaults(bank?: BankListItem): FormValues {
  return {
    name: bank?.name ?? '',
    phone: bank?.phone ?? '',
    website: bank?.website ?? '',
    email: bank?.email ?? '',
    address: bank?.address ?? '',
  };
}

export function BankFormDialog({
  trigger,
  bank,
}: {
  trigger: ReactNode;
  bank?: BankListItem;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const isEdit = Boolean(bank);

  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<FormValues>({ defaultValues: defaults(bank) });

  async function onSubmit(values: FormValues) {
    const result = isEdit
      ? await updateBankAction({ id: bank!.id, ...values })
      : await createBankAction(values);

    if (!result.ok) {
      toast.error(result.error);
      return;
    }

    toast.success(isEdit ? 'Банк обновлён' : 'Банк добавлен');
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset(defaults(bank));
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Редактировать банк' : 'Новый банк'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="name">Название</Label>
            <Input id="name" required {...register('name')} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="phone">Телефон</Label>
              <Input id="phone" {...register('phone')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="website">Сайт</Label>
              <Input id="website" {...register('website')} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" {...register('email')} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="address">Адрес</Label>
            <Input id="address" {...register('address')} />
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
