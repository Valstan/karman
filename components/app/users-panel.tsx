'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { Copy, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import {
  createAccountAction,
  resetAccountPasswordAction,
  setAccountActiveAction,
} from '@/lib/actions/users';
import type { AccountListItem } from '@/lib/services/users';

/**
 * Панель управления аккаунтами (только superuser): приглашение нового человека,
 * сброс пароля и отключение учётки.
 *
 * Приглашение — ЕДИНСТВЕННЫЙ путь появления людей в системе: самостоятельной
 * регистрации нет, а вход через ЕСА с 2026-09-03 только впускает уже заведённых.
 * Временный пароль (и при заведении, и при сбросе) показывается ОДИН раз:
 * в базе лежит только хеш, повторно достать его неоткуда — можно лишь сбросить.
 */

type Issued = { username: string; tempPassword: string; kind: 'created' | 'reset' };

type InviteValues = {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
};

const EMPTY_INVITE: InviteValues = { username: '', email: '', firstName: '', lastName: '' };

function InviteDialog({ onIssued }: { onIssued: (issued: Issued) => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<InviteValues>({ defaultValues: EMPTY_INVITE });

  async function onSubmit(values: InviteValues) {
    const result = await createAccountAction(values);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    onIssued({ ...result.data!, kind: 'created' });
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset(EMPTY_INVITE);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <UserPlus className="mr-1 h-4 w-4" /> Пригласить
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Пригласить человека</DialogTitle>
          <DialogDescription>
            Аккаунт заводится сразу, с временным паролем. Разделы у нового человека пустые:
            свои кредиты, документы и данные он заполняет сам, а чужие ему не видны.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="invite-username">Логин</Label>
            <Input
              id="invite-username"
              placeholder="ulyana"
              autoComplete="off"
              {...register('username')}
            />
            <p className="text-xs text-muted-foreground">
              Латиница, цифры, точка, дефис, подчёркивание. Его человек будет вводить при входе.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="invite-email">Почта (необязательно)</Label>
            <Input id="invite-email" type="email" autoComplete="off" {...register('email')} />
            <p className="text-xs text-muted-foreground">
              Если указать ту же почту, что в ЕСА вМалмыже, человек сможет входить кнопкой
              «Войти через ЕСА» вместо пароля.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="invite-first">Имя</Label>
              <Input id="invite-first" {...register('firstName')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-last">Фамилия</Label>
              <Input id="invite-last" {...register('lastName')} />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Заведение…' : 'Завести аккаунт'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function UsersPanel({
  accounts,
  currentUserId,
}: {
  accounts: AccountListItem[];
  currentUserId: number;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);

  async function reset(id: number) {
    setBusyId(id);
    const result = await resetAccountPasswordAction({ userId: id });
    setBusyId(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setIssued({ ...result.data!, kind: 'reset' });
  }

  async function toggleActive(id: number, username: string, next: boolean) {
    setBusyId(id);
    const result = await setAccountActiveAction({ userId: id, isActive: next });
    setBusyId(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(next ? `Аккаунт «${username}» включён` : `Аккаунт «${username}» отключён`);
    router.refresh();
  }

  async function copyIssued() {
    if (!issued) return;
    await navigator.clipboard.writeText(
      `Логин: ${issued.username}\nВременный пароль: ${issued.tempPassword}`,
    );
    toast.success('Логин и пароль скопированы');
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-muted-foreground" />
              Пользователи
            </CardTitle>
            <CardDescription>
              Приглашение, сброс пароля и отключение учёток. Временный пароль передайте
              человеку лично — после входа он сменит его в «Настройках».
            </CardDescription>
          </div>
          <InviteDialog onIssued={setIssued} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {issued && (
          <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
            <p>
              {issued.kind === 'created' ? 'Аккаунт заведён. ' : ''}
              Временный пароль для <b>{issued.username}</b> (показывается один раз):
            </p>
            <p className="font-mono text-base">{issued.tempPassword}</p>
            <Button variant="outline" size="sm" className="w-fit" onClick={copyIssued}>
              <Copy className="mr-2 h-4 w-4" />
              Скопировать логин и пароль
            </Button>
          </div>
        )}
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-2 font-medium">Логин</th>
              <th className="py-2 font-medium">Роль</th>
              <th className="py-2 font-medium">Последний вход</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} className="border-b last:border-0">
                <td className="py-2 font-medium">{a.username}</td>
                <td className="py-2 text-muted-foreground">
                  {a.isSuperuser ? 'суперпользователь' : 'пользователь'}
                  {!a.isActive && ' · отключён'}
                </td>
                <td className="py-2 text-muted-foreground">
                  {a.lastLogin ? new Date(a.lastLogin).toLocaleDateString('ru-RU') : 'не входил'}
                </td>
                <td className="flex justify-end gap-2 py-2">
                  <ConfirmDialog
                    trigger={
                      <Button variant="outline" size="sm" disabled={busyId !== null}>
                        {busyId === a.id ? 'Сброс…' : 'Сбросить пароль'}
                      </Button>
                    }
                    title={`Сбросить пароль «${a.username}»?`}
                    description="Старый пароль перестанет работать. Второй фактор сброс не обходит."
                    confirmText="Сбросить"
                    onConfirm={() => reset(a.id)}
                  />
                  {a.id !== currentUserId &&
                    (a.isActive ? (
                      <ConfirmDialog
                        trigger={
                          <Button variant="outline" size="sm" disabled={busyId !== null}>
                            Отключить
                          </Button>
                        }
                        title={`Отключить «${a.username}»?`}
                        description="Человек перестанет входить любым способом, включая ЕСА, и его текущая сессия перестанет работать. Данные сохранятся."
                        confirmText="Отключить"
                        onConfirm={() => toggleActive(a.id, a.username, false)}
                      />
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyId !== null}
                        onClick={() => toggleActive(a.id, a.username, true)}
                      >
                        Включить
                      </Button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
