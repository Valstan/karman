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
import { createProjectAction, updateProjectAction } from '@/lib/actions/secrets';

type ProjectFields = { id: number; name: string; slug: string };
type FormValues = { name: string; slug: string };

export function SecretProjectDialog({
  trigger,
  project,
}: {
  trigger: ReactNode;
  project?: ProjectFields;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const isEdit = Boolean(project);

  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<FormValues>({ defaultValues: { name: project?.name ?? '', slug: project?.slug ?? '' } });

  async function onSubmit(values: FormValues) {
    const result = isEdit
      ? await updateProjectAction({ id: project!.id, ...values })
      : await createProjectAction(values);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(isEdit ? 'Проект обновлён' : 'Проект создан');
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset({ name: project?.name ?? '', slug: project?.slug ?? '' });
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Редактировать проект' : 'Новый проект'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="name">Название</Label>
            <Input id="name" required maxLength={200} {...register('name')} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="slug">Слаг</Label>
            <Input id="slug" required placeholder="my-project" {...register('slug')} />
            <p className="text-xs text-muted-foreground">
              Латиница в нижнем регистре, цифры, дефис. Человекочитаемый идентификатор.
            </p>
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
