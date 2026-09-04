'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogIn, Link2, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import {
  confirmEsaLinkAction,
  dismissEsaLinkAction,
  startEsaLinkAction,
  unlinkEsaAction,
} from '@/lib/actions/esa-link';

export type PendingLink = { email: string | null; name: string | null };
export type LinkedIdentity = { email: string | null; createdAt: string };

export function EsaLinkPanel({
  configured,
  identity,
  pending,
  username,
  canUnlink,
}: {
  configured: boolean;
  identity: LinkedIdentity | null;
  pending: PendingLink | null;
  username: string;
  canUnlink: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function start() {
    setBusy(true);
    const res = await startEsaLinkAction();
    if (!res.ok || !res.data) {
      setBusy(false);
      toast.error(res.ok ? 'Не удалось начать привязку' : res.error);
      return;
    }
    // Переход делает клиент: server action не может увести браузер на чужой хост.
    window.location.assign(res.data.url);
  }

  async function confirm() {
    setBusy(true);
    const res = await confirmEsaLinkAction();
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      router.refresh();
      return;
    }
    toast.success(res.data?.already ? 'Эта личность уже была привязана' : 'ВКонтакте привязан');
    router.refresh();
  }

  async function dismiss() {
    setBusy(true);
    await dismissEsaLinkAction();
    setBusy(false);
    router.refresh();
  }

  async function unlink() {
    setBusy(true);
    const res = await unlinkEsaAction();
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success('Привязка снята');
    router.refresh();
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LogIn className="h-5 w-5" /> Вход через ВКонтакте
        </CardTitle>
        <CardDescription>
          Привяжите аккаунт ВКонтакте — и входить можно будет одной кнопкой, через единый вход
          вмалмыже.рф. Пароль при этом остаётся: он и запасной путь, и способ снять привязку.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!configured ? (
          <p className="text-sm text-muted-foreground">
            Единый вход не настроен на сервере — кнопка появится, когда его включат.
          </p>
        ) : pending ? (
          <div className="flex flex-col gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
            <div className="text-sm">
              <p className="font-medium">Подтвердите привязку</p>
              {/*
                Главный смысл экрана: человек видит, ЧЬЯ личность вернулась.
                Мы просим провайдера переспросить (`prompt=login`), но исполнит
                ли он это — не в нашей власти; если в браузере осталась чужая
                сессия ЕСА, привязалась бы она. Глазами это заметно, кодом нет.
              */}
              <p className="mt-1 text-muted-foreground">
                Привязать{' '}
                <span className="font-mono">{pending.email ?? pending.name ?? 'эту личность'}</span>{' '}
                к учётной записи <span className="font-mono">{username}</span>?
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Если это не ваш аккаунт ВКонтакте — откажитесь и начните заново.
              </p>
            </div>
            <div className="flex gap-2">
              <Button onClick={confirm} disabled={busy}>
                <Link2 className="mr-1 h-4 w-4" /> Привязать
              </Button>
              <Button variant="outline" onClick={dismiss} disabled={busy}>
                Отказаться
              </Button>
            </div>
          </div>
        ) : identity ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              Привязан{' '}
              <span className="font-mono">
                {identity.email ?? 'аккаунт ВКонтакте (почта не передана)'}
              </span>
            </p>
            {canUnlink ? (
              <ConfirmDialog
                title="Снять привязку ВКонтакте?"
                description="Входить можно будет только паролем. Привязать заново можно в любой момент."
                confirmText="Отвязать"
                onConfirm={unlink}
                trigger={
                  <Button variant="outline" disabled={busy}>
                    <Unlink className="mr-1 h-4 w-4" /> Отвязать
                  </Button>
                }
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                Отвязать нельзя: сейчас это ваш единственный способ войти. Задайте пароль ниже — и
                кнопка появится.
              </p>
            )}
          </div>
        ) : (
          <Button onClick={start} disabled={busy}>
            <Link2 className="mr-1 h-4 w-4" /> Привязать аккаунт ВКонтакте
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
