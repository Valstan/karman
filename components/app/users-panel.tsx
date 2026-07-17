'use client';

import { useState } from 'react';
import { Copy, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { resetAccountPasswordAction } from '@/lib/actions/users';
import type { AccountListItem } from '@/lib/services/users';

/**
 * Панель восстановления доступа (только superuser): список аккаунтов + сброс
 * пароля на временный. Временный пароль показывается ОДИН раз — владелец
 * передаёт его человеку лично; 2FA (если включена) сброс не обходит.
 */
export function UsersPanel({ accounts }: { accounts: AccountListItem[] }) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [issued, setIssued] = useState<{ username: string; tempPassword: string } | null>(null);

  async function reset(id: number, username: string) {
    if (!window.confirm(`Сбросить пароль аккаунта «${username}»? Старый пароль перестанет работать.`)) {
      return;
    }
    setBusyId(id);
    const result = await resetAccountPasswordAction({ userId: id });
    setBusyId(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setIssued(result.data!);
  }

  async function copyIssued() {
    if (!issued) return;
    await navigator.clipboard.writeText(`Логин: ${issued.username}\nВременный пароль: ${issued.tempPassword}`);
    toast.success('Логин и пароль скопированы');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5 text-muted-foreground" />
          Пользователи
        </CardTitle>
        <CardDescription>
          Восстановление доступа: сброс пароля на временный. Передайте его человеку лично —
          после входа он сменит пароль в «Настройках».
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {issued && (
          <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
            <p>
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
                <td className="py-2 text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyId !== null}
                    onClick={() => reset(a.id, a.username)}
                  >
                    {busyId === a.id ? 'Сброс…' : 'Сбросить пароль'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
