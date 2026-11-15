'use client';

import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { copyAccountSecret } from '@/components/app/minimax-activation';
import type { MinimaxTokenFlow } from './minimax-token-flow';
import type { TokenProgress } from '@/lib/services/account-tokens';

/**
 * Карточка добычи токенов — в разделе «Минимакс» (заказ владельца 14.11 + 15.11).
 *
 * Отдельной страницы «Токены аккаунтов MiniMax» больше нет: заказ 15.11 — «всё в
 * одном месте, одна страница Минимакс». Здесь владелец жмёт «Следующий», открывает
 * ссылку MiniMax, входит этим аккаунтом и подтверждает; страница сама забирает
 * токен и кладёт пару в базу.
 *
 * Сам поток живёт в хуке `useMinimaxTokenFlow` — он общий для карточки и для
 * кнопок «Получить токен» в строках аккаунтов (заказ 15.11: «у нас сейчас почти на
 * все аккаунты есть токены… если нету, то предлагай его получить»).
 *
 * Статусы токена — ровно два («Без токена» и «Токен получен»): состояние по
 * аккаунтам видно в строках списка, здесь — счётчик и сам процесс.
 */
export function MinimaxTokenTool({
  progress,
  flow,
}: {
  /** Счётчики по пулу: сколько пар есть, сколько осталось. */
  progress: TokenProgress;
  /** Текущий поток добычи (общий для карточки и строк списка). */
  flow: MinimaxTokenFlow;
}) {
  const done = progress.complete;

  /** Пароль в буфер обмена; после копирования модалка закрывается. */
  async function copyPassword() {
    if (!flow.passwordPrompt) return;
    const outcome = await copyAccountSecret(
      { id: flow.passwordPrompt.id, email: flow.passwordPrompt.email },
      'password',
    );
    if (!outcome.ok) {
      toast.error(outcome.error);
      return;
    }
    toast.success('Пароль скопирован — вставьте его в окне MiniMax');
    flow.setPasswordPrompt(null);
  }

  return (
    <div className="rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-lg font-medium">
            Токены: {progress.withToken} из {progress.total}
          </p>
          <p className="text-sm text-muted-foreground">
            {done
              ? 'Все токены получены — процесс завершён.'
              : `Осталось ${progress.remaining}${
                  progress.pending > 0 ? `, в ожидании подтверждения: ${progress.pending}` : ''
                }.`}
          </p>
        </div>
        <div className="flex gap-2">
          {flow.flow ? (
            <>
              <Button variant="outline" onClick={flow.claimNow} disabled={flow.pending}>
                Забрать токен
              </Button>
              <Button variant="ghost" onClick={flow.cancel} disabled={flow.pending}>
                Отменить
              </Button>
            </>
          ) : (
            <Button onClick={() => flow.start()} disabled={flow.busy || done}>
              {done ? 'Все токены получены' : 'Следующий'}
            </Button>
          )}
        </div>
      </div>

      {flow.flow ? (
        <div className="mt-4 rounded-md bg-muted p-3 text-sm">
          <p>
            Аккаунт #{flow.flow.account_id} «{flow.flow.title || flow.flow.email}» —{' '}
            {flow.flow.email}
          </p>
          <p className="mt-2">
            Код подтверждения: <span className="font-mono text-base">{flow.flow.user_code}</span>
          </p>
          <p className="mt-2">
            <a
              href={flow.flow.verification_link}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-primary underline"
            >
              Открыть подтверждение MiniMax
            </a>{' '}
            — войдите этим аккаунтом и подтвердите. Код жив до{' '}
            {new Date(flow.flow.expires_at).toLocaleTimeString('ru-RU')}.
          </p>
          <p className="mt-2 text-muted-foreground">
            {flow.phase === 'waiting' && 'Ждём подтверждения — страница забирает токен сама.'}
          </p>
        </div>
      ) : null}

      {/* Пароль от аккаунта: копируем и закрываемся. Фокус не забираем — ввод в
          только что открытом окне MiniMax должен остаться доступен. */}
      <Dialog
        open={flow.passwordPrompt !== null}
        onOpenChange={(open) => {
          if (!open) flow.setPasswordPrompt(null);
        }}
      >
        <DialogContent onOpenAutoFocus={(event) => event.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Пароль от аккаунта</DialogTitle>
            <DialogDescription>
              Аккаунт #{flow.passwordPrompt?.id} «{flow.passwordPrompt?.title || '—'}». Почта уже в
              буфере обмена — вставьте её в окне MiniMax. Пароль нужен там же для входа:
              нажмите кнопку, он попадёт в буфер, и окно закроется.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              Почта: <span className="font-mono">{flow.passwordPrompt?.email}</span>
            </p>
            <Button onClick={() => void copyPassword()}>
              <KeyRound className="mr-1 h-4 w-4" /> Скопировать пароль
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
