'use client';

import { useState, type ReactNode } from 'react';
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
import { createAccountAction, updateAccountAction } from '@/lib/actions/accounts';
import type { AccountListItem } from '@/lib/services/accounts';

type Values = { title: string; email: string; password: string };

/**
 * Диалог добавления/правки аккаунта.
 *
 * Пароль обязателен при СОЗДАНИИ (его потом копируют в сервис, куда владелец
 * входит). При правке пароль можно не трогать — тогда он остаётся прежним.
 */
export function MinimaxFormDialog({
  account,
  trigger,
}: {
  account?: AccountListItem;
  trigger: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Values>({
    title: account?.title ?? '',
    email: account?.email ?? '',
    password: '',
  });
  const [saving, setSaving] = useState(false);

  function reset() {
    setValues({ title: account?.title ?? '', email: account?.email ?? '', password: '' });
  }

  async function onSubmit() {
    if (!values.email.trim()) {
      toast.error('Укажите почту');
      return;
    }
    if (!account && !values.password) {
      toast.error('Укажите пароль');
      return;
    }
    setSaving(true);
    const payload = {
      title: values.title.trim(),
      email: values.email.trim(),
      ...(values.password ? { password: values.password } : {}),
    };
    const result = account
      ? await updateAccountAction({ id: account.id, ...payload })
      : await createAccountAction(payload);
    setSaving(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(account ? 'Аккаунт обновлён' : 'Аккаунт добавлен');
    setOpen(false);
    reset();
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{account ? 'Аккаунт' : 'Новый аккаунт'}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="account-title">Название</Label>
            <Input
              id="account-title"
              value={values.title}
              placeholder="Например: Матрица РМЗ — 1"
              onChange={(e) => setValues((v) => ({ ...v, title: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="account-email">Почта</Label>
            <Input
              id="account-email"
              value={values.email}
              placeholder="почта@сервис"
              autoComplete="off"
              onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="account-password">
              Пароль{account ? ' (оставьте пустым, чтобы не менять)' : ''}
            </Label>
            <Input
              id="account-password"
              type="password"
              value={values.password}
              autoComplete="new-password"
              onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onSubmit} disabled={saving}>
            {account ? 'Сохранить' : 'Добавить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
