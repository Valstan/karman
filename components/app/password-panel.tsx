'use client';

import { useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { changeOwnPasswordAction } from '@/lib/actions/users';

export function PasswordPanel() {
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const nextPassword = String(form.get('nextPassword') ?? '');
    if (nextPassword !== String(form.get('nextPassword2') ?? '')) {
      toast.error('Новый пароль и повтор не совпадают');
      return;
    }
    setBusy(true);
    const result = await changeOwnPasswordAction({
      currentPassword: String(form.get('currentPassword') ?? ''),
      nextPassword,
    });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    formEl.reset();
    toast.success('Пароль изменён');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          Пароль
        </CardTitle>
        <CardDescription>Смена пароля входа. Действующие сессии не разрываются.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex max-w-sm flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="currentPassword">Текущий пароль</Label>
            <Input
              id="currentPassword"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="nextPassword">Новый пароль</Label>
            <Input
              id="nextPassword"
              name="nextPassword"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="nextPassword2">Новый пароль ещё раз</Label>
            <Input
              id="nextPassword2"
              name="nextPassword2"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? 'Сохранение…' : 'Сменить пароль'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
