'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, ExternalLink, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { copyAccountSecret } from '@/components/app/minimax-activation';

/** Зелёная кнопка — «можно нажать» (как в окне «Минимакса»). */
const GREEN_BUTTON =
  'bg-emerald-600 text-white shadow-sm hover:bg-emerald-500 hover:text-white';
/** Потраченная кнопка: серая, но нажимаемая — скопировать почту можно и второй раз. */
const SPENT_BUTTON =
  'bg-muted text-muted-foreground shadow-none hover:bg-muted hover:text-muted-foreground';

/**
 * Всплывающее окно «пароль от аккаунта» — отдельное окно ОС поверх браузера
 * (заказ владельца 14.11: «сделай такое же, как и при активации аккаунта, чтобы
 * это отдельное окно поверх браузера было, чтобы я на клавиатуре мог быстро на
 * него переключиться»).
 *
 * Логика ровно как в окне «Минимакса» (`/minimax-window`): окно отдельное,
 * компактное, без шапки и меню; кнопка копирования пароля, после копирования окно
 * закрывается.
 *
 * Почему окно, а не диалог в странице: вкладка с подтверждением MiniMax уводит
 * фокус, и до диалога в соседней вкладке не дотянуться — а до отдельного окна
 * можно переключиться с клавиатуры (Alt+Tab).
 */
export function MinimaxTokenWindow({
  accountId,
  title,
  email,
  emailCopied = false,
  verificationLink = null,
}: {
  accountId: number;
  title: string;
  email: string;
  /** Почта уже в буфере — кнопка посеревена, чтобы не путать. */
  emailCopied?: boolean;
  /** Ссылка подтверждения MiniMax — запасной путь, если вкладка не открылась. */
  verificationLink?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  /** Почту скопировали в этом окне — кнопка сереет. */
  const [copiedEmail, setCopiedEmail] = useState(emailCopied);

  async function copy(kind: 'email' | 'password') {
    setBusy(true);
    try {
      const outcome = await copyAccountSecret({ id: accountId, email }, kind);
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      toast.success(kind === 'password' ? 'Пароль скопирован' : 'Почта скопирована');
      if (kind === 'email') {
        setCopiedEmail(true);
        return;
      }
      // Пароль уже в буфере — держать окно незачем, закрываем сразу.
      window.close();
    } finally {
      setBusy(false);
    }
  }

  return (
    // Как в окне «Минимакса»: по центру окна, колонка одной ширины — целиться
    // при быстрой работе проще (заказ владельца 12.11).
    <div className="flex min-h-screen flex-col items-center gap-4 p-4 text-center">
      <div className="flex w-full max-w-[420px] flex-col items-center gap-4">
        <div>
          <h1 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Минимакс — пароль
          </h1>
          <div className="text-lg font-semibold leading-tight">{title || '—'}</div>
          <div className="font-mono text-sm text-muted-foreground">{email}</div>
        </div>

        {/* ПОРЯДОК = порядок работы владельца: почта уже в буфере (её копирует
            «Следующий» до открытия окон) → пароль → подтверждение в соседней
            вкладке. */}
        <div className="flex w-full flex-col gap-2">
          <Button
            variant="default"
            className={copiedEmail ? SPENT_BUTTON : GREEN_BUTTON}
            onClick={() => void copy('email')}
            disabled={busy}
            title={
              copiedEmail
                ? 'Почта уже скопирована — можно скопировать снова'
                : 'Скопировать почту в буфер обмена'
            }
          >
            <Copy className="mr-1 h-4 w-4" />
            {copiedEmail ? 'Почта уже скопирована' : 'Скопировать почту'}
          </Button>
          <Button
            variant="default"
            className={GREEN_BUTTON}
            onClick={() => void copy('password')}
            disabled={busy}
            title="Скопировать пароль в буфер обмена — окно закроется"
          >
            <KeyRound className="mr-1 h-4 w-4" /> Скопировать пароль
          </Button>
        </div>

        {verificationLink ? (
          <Button variant="outline" asChild>
            <a href={verificationLink} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-1 h-4 w-4" /> Открыть подтверждение MiniMax
            </a>
          </Button>
        ) : null}

        <Button variant="outline" onClick={() => window.close()} disabled={busy}>
          Закрыть окно
        </Button>

        <p className="w-full text-xs text-muted-foreground">
          После копирования пароля окно закрывается. Подтверждение MiniMax — в соседней
          вкладке: вставьте почту, потом пароль.
        </p>
      </div>
    </div>
  );
}
