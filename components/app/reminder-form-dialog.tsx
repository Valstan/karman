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
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createReminderAction, updateReminderAction } from '@/lib/actions/reminders';
import type { ReminderListItem } from '@/lib/services/reminders';

type FormValues = {
  title: string;
  body: string;
  at: string;
  priority: 'normal' | 'high';
  silent: boolean;
};

function defaults(reminder?: ReminderListItem): FormValues {
  return {
    title: reminder?.title ?? '',
    body: reminder?.body ?? '',
    at: reminder?.at ?? '',
    priority: reminder?.priority ?? 'normal',
    silent: reminder?.silent ?? false,
  };
}

export function ReminderFormDialog({
  trigger,
  reminder,
}: {
  trigger: ReactNode;
  reminder?: ReminderListItem;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const isEdit = Boolean(reminder);
  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { isSubmitting },
  } = useForm<FormValues>({ defaultValues: defaults(reminder) });

  async function onSubmit(values: FormValues) {
    const result = isEdit
      ? await updateReminderAction({ id: reminder!.id, ...values })
      : await createReminderAction(values);

    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(isEdit ? 'Напоминание обновлено' : 'Напоминание создано');
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset(defaults(reminder));
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Редактировать напоминание' : 'Новое напоминание'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="title">Заголовок</Label>
            <Input id="title" required maxLength={200} {...register('title')} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="body">Текст (необязательно)</Label>
            <Textarea id="body" rows={3} {...register('body')} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="at">Когда напомнить (МСК)</Label>
            <Input id="at" type="datetime-local" required {...register('at')} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Приоритет</Label>
              <Controller
                control={control}
                name="priority"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">Обычный</SelectItem>
                      <SelectItem value="high">Важный (без тихих часов)</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" className="h-4 w-4" {...register('silent')} />
              Без звука
            </label>
          </div>
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
