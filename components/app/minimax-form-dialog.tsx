'use client';

import { useState, type ReactNode } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createAccountAction, updateAccountAction } from '@/lib/actions/accounts';
import type { AccountListItem, ProjectListItem } from '@/lib/services/accounts';

const NONE = '__none__';

type Values = { title: string; email: string; password: string };

/**
 * Диалог добавления/правки аккаунта.
 *
 * Пароль обязателен при СОЗДАНИИ (его потом копируют в сервис, куда владелец
 * входит). При правке пароль можно не трогать — тогда он остаётся прежним.
 *
 * При правке можно сменить проект аккаунта (04.11: «может быть, изменить
 * проект»): это проект, который подставится по умолчанию при следующей
 * активации. Статистика при этом не переписывается — она живёт в журнале
 * активаций.
 *
 * Два режима: С КНОПКОЙ (своя кнопка открывает) и УПРАВЛЯЕМЫЙ (открывает
 * родитель — так раздел перехватывает правку уже погашенного аккаунта и
 * сначала спрашивает, что делать: обновить страницу или править).
 */
export function MinimaxFormDialog({
  account,
  trigger,
  projects,
  open: openProp,
  onOpenChange: onOpenChangeProp,
}: {
  account?: AccountListItem;
  /** Кнопка-триггер. В управляемом режиме не нужна. */
  trigger?: ReactNode;
  projects?: ProjectListItem[];
  /** Управляемый режим: `undefined` — диалог сам держит открытость. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const router = useRouter();
  const [ownOpen, setOwnOpen] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : ownOpen;
  const [values, setValues] = useState<Values>({
    title: account?.title ?? '',
    email: account?.email ?? '',
    password: '',
  });
  const [project, setProject] = useState<string>(
    account?.projectId === null || account?.projectId === undefined
      ? NONE
      : String(account.projectId),
  );
  const [saving, setSaving] = useState(false);

  function reset() {
    setValues({ title: account?.title ?? '', email: account?.email ?? '', password: '' });
    setProject(
      account?.projectId === null || account?.projectId === undefined
        ? NONE
        : String(account.projectId),
    );
  }

  function changeOpen(next: boolean) {
    if (!controlled) setOwnOpen(next);
    onOpenChangeProp?.(next);
    if (!next) reset();
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
      ? await updateAccountAction({
          id: account.id,
          ...payload,
          projectId: project === NONE ? null : Number(project),
        })
      : await createAccountAction(payload);
    setSaving(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(account ? 'Аккаунт обновлён' : 'Аккаунт добавлен');
    changeOpen(false);
    reset();
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{account ? 'Аккаунт' : 'Новый аккаунт'}</DialogTitle>
          <DialogDescription>
            {account
              ? 'Название, почта и проект аккаунта. Пароль оставьте пустым, чтобы не менять его.'
              : 'Логин и пароль от аккаунта MiniMax. Пароль хранится зашифрованным и показывается только по запросу.'}
          </DialogDescription>
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
          {account && projects && projects.length > 0 ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor="account-project">Проект аккаунта</Label>
              <Select value={project} onValueChange={setProject}>
                <SelectTrigger id="account-project">
                  <SelectValue placeholder="Без проекта" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Без проекта</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
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
