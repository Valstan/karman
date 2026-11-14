'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  claimTokenAction,
  cancelTokenFlowAction,
  nextTokenFlowAction,
} from '@/lib/actions/account-tokens';
import type { NextTokenFlow, TokenProgress } from '@/lib/services/account-tokens';

/**
 * Инструмент добычи токенов аккаунтов MiniMax (заказ владельца 14.11).
 *
 * Сценарий: владелец жмёт «Следующий» → получает ссылку и код подтверждения MiniMax →
 * открывает ссылку, входит и подтверждает → страница сама опрашивает обмен кода и
 * кладёт пару токенов в базу. Аккаунты с уже добытым токеном пропускаются; когда
 * токены есть у всех — процесс останавливается и говорит об этом.
 *
 * Опрашивать можно и рукой («Забрать токен») — на случай, если браузер спит.
 */

type FlowState = 'idle' | 'waiting' | 'claimed' | 'expired';

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
  const [busy, startTransition] = useTransition();
  const [pending, startPending] = useTransition();

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
        }
      })();
    }, Math.max(3, flow.interval_seconds) * 1000);
    return () => clearInterval(timer);
  }, [flow, state, router]);

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
      toast.info(
        next.resumed
          ? `Продолжаем: аккаунт #${next.account_id} «${next.title}»`
          : `Аккаунт #${next.account_id} «${next.title}» — откройте ссылку`,
      );
    });
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
    </div>
  );
}
