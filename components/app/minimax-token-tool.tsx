'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  claimTokenAction,
  cancelTokenFlowAction,
  nextTokenFlowAction,
} from '@/lib/actions/account-tokens';
import { copyAccountSecret } from '@/components/app/minimax-activation';
import type { NextTokenFlow, TokenProgress } from '@/lib/services/account-tokens';

/**
 * Инструмент получения токенов аккаунтов MiniMax (заказ владельца 14.11).
 *
 * Сценарий: владелец жмёт «Следующий» → получает ссылку и код подтверждения MiniMax →
 * открывает ссылку, входит и подтверждает → страница сама опрашивает обмен кода и
 * кладёт пару токенов в базу. Аккаунты с уже добытым токеном пропускаются; когда
 * токены есть у всех — процесс останавливается и говорит об этом.
 *
 * Опрашивать можно и рукой («Забрать токен») — на случай, если браузер спит.
 *
 * ## Ускорение рутины (заказ владельца 14.11, второй заход)
 *
 * «Нажми "Следующий" — сразу перейди по ссылке, скопируй почту в буфер, открой
 * модалку с кнопкой копирования пароля; после копирования пароля модалка закрывается».
 * Поэтому «Следующий» теперь делает всё сразу:
 *
 * 1) **кладёт почту аккаунта в буфер обмена** — вставьте её в окне MiniMax. Именно
 *    ПЕРВЫМ: clipboard API браузера требует фокуса документа, а открытое окно MiniMax
 *    уводит вкладку в фон, и копирование после этого падает;
 * 2) **открывает подтверждение MiniMax** новым окном;
 * 3) **показывает модалку с кнопкой «Скопировать пароль»** — пароль нужен для входа
 *    в тот же MiniMax; после копирования модалка закрывается сама.
 *
 * Модалка намеренно НЕ забирает фокус (`onOpenAutoFocus` отменён): иначе она
 * перехватила бы ввод в только что открытом окне MiniMax.
 */

type FlowState = 'idle' | 'waiting' | 'claimed' | 'expired';

/** Аккаунт, для которого показываем модалку с паролем. */
type PasswordPrompt = { id: number; title: string; email: string };

const STATE_LABEL: Record<string, string> = {
  none: 'нет токена',
  pending: 'ждём подтверждения',
  stored: 'токен получен',
  handed_over: 'отдан проекту',
};

export function MinimaxTokenTool({ progress }: { progress: TokenProgress }) {
  const router = useRouter();
  const [flow, setFlow] = useState<NextTokenFlow | null>(null);
  const [state, setState] = useState<FlowState>('idle');
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPrompt | null>(null);
  const [busy, startTransition] = useTransition();
  const [pending, startPending] = useTransition();
  // Пауза между опросами обмена. Вендер сам задаёт её в `interval` (живая проба:
  // 3 секунды), а на `slow_down` просит опрашивать реже — тогда отступаем вдвое.
  const [pollMs, setPollMs] = useState(3000);

  // Пока код жив — опрашиваем обмен: MiniMax отвечает «authorization_pending», пока
  // владелец не подтвердил. Как только пара получена — останавливаемся.
  useEffect(() => {
    if (!flow || state !== 'waiting') return;
    const timer = setInterval(() => {
      void (async () => {
        const result = await claimTokenAction(flow.flow_id);
        if (!result.ok || !result.data) return;
        const claim = result.data;
        if (claim.ok) {
          setState('claimed');
          setFlow(null);
          toast.success(`Токен получен: аккаунт #${claim.account_id} «${claim.title}»`);
          router.refresh();
          return;
        }
        if (claim.error === 'expired_token') {
          setState('expired');
          toast.error('Код истёк — жмите «Следующий» для нового');
          router.refresh();
          return;
        }
        if (claim.error === 'slow_down') {
          // Вендер просит опрашивать реже — отступаем (до минуты).
          setPollMs((prev) => Math.min(prev * 2, 60_000));
        }
      })();
    }, pollMs);
    return () => clearInterval(timer);
  }, [flow, state, pollMs, router]);

  function next() {
    startTransition(async () => {
      const result = await nextTokenFlowAction();
      if (!result.ok || !result.data) {
        toast.error(result.ok ? 'Пустой ответ' : result.error);
        if (!result.ok && result.error.includes('Все токены')) setState('claimed');
        return;
      }
      const next = result.data;
      setFlow(next);
      setState('waiting');
      setPollMs(Math.max(3, next.interval_seconds) * 1000);

      // 1) ПОЧТА — в буфер обмена, ПОКА вкладка активна. Clipboard API браузера
      //    требует фокуса документа: если сначала открыть окно MiniMax, вкладка
      //    останется на фоне и копирование упадёт («Document is not focused»).
      let copied = false;
      try {
        await navigator.clipboard.writeText(next.email);
        copied = true;
      } catch {
        toast.error('Не удалось скопировать почту — она показана в окне, скопируйте вручную');
      }

      // 2) Сразу уводим в подтверждение MiniMax.
      const tab = window.open(next.verification_link, '_blank');
      if (!tab) {
        toast.info('Браузер заблокировал новое окно — откройте ссылку подтверждения ниже');
      }

      // 3) Модалка с кнопкой копирования пароля (фокус не забираем — ввод в окне
      //    MiniMax должен остаться доступен).
      setPasswordPrompt({ id: next.account_id, title: next.title, email: next.email });
      if (copied) {
        toast.info('Почта скопирована — вставьте её в окне MiniMax');
      }
    });
  }

  /** Пароль в буфер обмена; после копирования модалка закрывается. */
  async function copyPassword() {
    if (!passwordPrompt) return;
    const outcome = await copyAccountSecret(
      { id: passwordPrompt.id, email: passwordPrompt.email },
      'password',
    );
    if (!outcome.ok) {
      toast.error(outcome.error);
      return;
    }
    toast.success('Пароль скопирован — вставьте его в окне MiniMax');
    setPasswordPrompt(null);
  }

  function claimNow() {
    if (!flow) return;
    startPending(async () => {
      const result = await claimTokenAction(flow.flow_id);
      if (!result.ok || !result.data) {
        toast.error(result.ok ? 'Пустой ответ' : result.error);
        return;
      }
      const claim = result.data;
      if (claim.ok) {
        setState('claimed');
        setFlow(null);
        toast.success(`Токен получен: аккаунт #${claim.account_id} «${claim.title}»`);
        router.refresh();
      } else if (claim.error === 'expired_token') {
        setState('expired');
        toast.error('Код истёк — жмите «Следующий» для нового');
        router.refresh();
      } else if (claim.error === 'not_found') {
        setState('expired');
        toast.error('Поток не найден — жмите «Следующий»');
      }
    });
  }

  function cancel() {
    if (!flow) return;
    startPending(async () => {
      await cancelTokenFlowAction(flow.flow_id);
      setFlow(null);
      setState('idle');
      router.refresh();
    });
  }

  const done = progress.complete;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border p-4">
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
            {flow ? (
              <>
                <Button variant="outline" onClick={claimNow} disabled={pending}>
                  Забрать токен
                </Button>
                <Button variant="ghost" onClick={cancel} disabled={pending}>
                  Отменить
                </Button>
              </>
            ) : (
              <Button onClick={next} disabled={busy || done}>
                {done ? 'Все токены получены' : 'Следующий'}
              </Button>
            )}
          </div>
        </div>

        {flow ? (
          <div className="mt-4 rounded-md bg-muted p-3 text-sm">
            <p>
              Аккаунт #{flow.account_id} «{flow.title || flow.email}» —{' '}
              {flow.email}
            </p>
            <p className="mt-2">
              Код подтверждения: <span className="font-mono text-base">{flow.user_code}</span>
            </p>
            <p className="mt-2">
              <a
                href={flow.verification_link}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-primary underline"
              >
                Открыть подтверждение MiniMax
              </a>{' '}
              — войдите этим аккаунтом и подтвердите. Код жив до{' '}
              {new Date(flow.expires_at).toLocaleTimeString('ru-RU')}.
            </p>
            <p className="mt-2 text-muted-foreground">
              {state === 'waiting' && 'Ждём подтверждения — страница забирает токен сама.'}
            </p>
          </div>
        ) : null}
      </div>

      <div className="rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="p-2">id</th>
              <th className="p-2">Аккаунт</th>
              <th className="p-2">Почта</th>
              <th className="p-2">Состояние</th>
            </tr>
          </thead>
          <tbody>
            {progress.rows.map((row) => (
              <tr key={row.account_id} className="border-b last:border-0">
                <td className="p-2 text-muted-foreground">{row.account_id}</td>
                <td className="p-2">{row.title || '—'}</td>
                <td className="p-2 text-muted-foreground">{row.email}</td>
                <td className="p-2">{STATE_LABEL[row.state] ?? row.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Пароль от аккаунта: копируем и закрываемся. Фокус не забираем — ввод в
          только что открытом окне MiniMax должен остаться доступен. */}
      <Dialog
        open={passwordPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setPasswordPrompt(null);
        }}
      >
        <DialogContent onOpenAutoFocus={(event) => event.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Пароль от аккаунта</DialogTitle>
            <DialogDescription>
              Аккаунт #{passwordPrompt?.id} «{passwordPrompt?.title || '—'}». Почта уже в
              буфере обмена — вставьте её в окне MiniMax. Пароль нужен там же для входа:
              нажмите кнопку, он попадёт в буфер, и окно закроется.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              Почта: <span className="font-mono">{passwordPrompt?.email}</span>
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
