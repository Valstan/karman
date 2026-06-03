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
import { createDocumentAction, updateDocumentAction } from '@/lib/actions/documents';
import type { DocumentListItem } from '@/lib/services/documents';

type FormValues = {
  title: string;
  documentType: string;
  documentNumber: string;
  issueDate: string;
  expiryDate: string;
  issuingAuthority: string;
  isActive: boolean;
};

function defaults(doc?: DocumentListItem): FormValues {
  return {
    title: doc?.title ?? '',
    documentType: doc?.documentType ?? '',
    documentNumber: doc?.documentNumber ?? '',
    issueDate: doc?.issueDate ?? '',
    expiryDate: doc?.expiryDate ?? '',
    issuingAuthority: doc?.issuingAuthority ?? '',
    isActive: doc?.isActive ?? true,
  };
}

export function DocumentFormDialog({
  trigger,
  document,
}: {
  trigger: ReactNode;
  document?: DocumentListItem;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const isEdit = Boolean(document);

  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<FormValues>({ defaultValues: defaults(document) });

  async function onSubmit(values: FormValues) {
    const result = isEdit
      ? await updateDocumentAction({ id: document!.id, ...values })
      : await createDocumentAction(values);

    if (!result.ok) {
      toast.error(result.error);
      return;
    }

    toast.success(isEdit ? 'Документ обновлён' : 'Документ добавлен');
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset(defaults(document));
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Редактировать документ' : 'Новый документ'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="title">Название</Label>
            <Input id="title" required {...register('title')} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="documentType">Тип</Label>
              <Input id="documentType" placeholder="Паспорт, СНИЛС…" {...register('documentType')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="documentNumber">Номер</Label>
              <Input id="documentNumber" {...register('documentNumber')} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="issueDate">Дата выдачи</Label>
              <Input id="issueDate" type="date" {...register('issueDate')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="expiryDate">Действует до</Label>
              <Input id="expiryDate" type="date" {...register('expiryDate')} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="issuingAuthority">Кем выдан</Label>
            <Input id="issuingAuthority" {...register('issuingAuthority')} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" {...register('isActive')} />
            Действующий
          </label>

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
