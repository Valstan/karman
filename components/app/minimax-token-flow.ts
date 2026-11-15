'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  cancelTokenFlowAction,
  claimTokenAction,
  nextTokenFlowAction,
} from '@/lib/actions/account-tokens';
import { centeredWindowFeatures, TOKEN_WINDOW_SIZE } from '@/lib/accounts/window-features';
import type { NextTokenFlow } from '@/lib/services/account-tokens';

/**
 * Статусы токена — РОВНО ДВА (заказ владельца 15.11):
 * «Без токена» и «Токен получен». Отдельного «протухла — нужен новый вход» больше
 * нет: протухший access мы оживляем по refresh (см. `ensureLiveAccessToken`).
 */
export const TOKEN_STATE_LABEL: Record<'none' | 'obtained', string> = {
  none: 'Без токена',
  obtained: 'Токен получен',
};

/** Аккаунт, для которого показываем модалку с паролем. */
export type TokenPasswordPrompt = { id: number; title: string; email: string };

/** Фаза процесса добычи. */
export type TokenFlowPhase = 'idle' | 'waiting' | 'claimed' | 'expired';

export type MinimaxTokenFlow = {
  /** Текущий device-flow (null — потока нет). */
  flow: NextTokenFlow | null;
  phase: TokenFlowPhase;
  /** Идёт запрос «Следующий». */
  busy: boolean;
  /** Идёт обмен кода вручную. */
  pending: boolean;
  /** Начать добычу: для конкретного аккаунта или для следующего без токена. */
  start: (accountId?: number) => void;
  /** Забрать токен руками (на случай, если браузер уснул). */
  claimNow: () => void;
  /** Отменить открытый поток. */
  cancel: () => void;
  /** Модалка с паролем — когда всплывающее окно заблокировали. */
  passwordPrompt: TokenPasswordPrompt | null;
  setPasswordPrompt: (prompt: TokenPasswordPrompt | null) => void;
};

/**
 * Добыча токена аккаунта MiniMax (заказ владельца 14.11) — как хук, чтобы и карточка
 * инструмента, и кнопки в строках аккаунтов вели ОДИН поток.
 *
 * Сценарий владельца: жмём «Следующий» → получаем ссылку и код подтверждения
 * MiniMax → открываем ссылку, входим и подтверждаем → страница сама опрашивает
 * обмен кода и кладёт пару токенов в базу.
 *
 * ## Ускорение рутины (заказ владельца 14.11, второй заход)
 *
 * «Нажми "Следующий" — сразу перейди по ссылке, скопируй почту в буфер, открой
 * окно с кнопкой копирования пароля; после копирования пароля окно закрывается».
 * Поэтому «Следующий» делает всё сразу:
 *
 * 1) **кладёт почту аккаунта в буфер обмена** — вставьте её в окне MiniMax. Именно
 *    ПЕРВЫМ: clipboard API браузера требует фокуса документа, а открытое окно
 *    MiniMax уводит вкладку в фон, и копирование после этого падает;
 * 2) **открывает подтверждение MiniMax** вкладкой в том же окне браузера;
 * 3) **открывает отдельное окно ОС с кнопкой «Скопировать пароль»** — пароль нужен
 *    для входа в тот же MiniMax; после копирования окно закрывается сама.
 *
 * Почему окно ОС, а не диалог в странице (заказ владельца 14.11): вкладка с
 * подтверждением MiniMax уводит фокус, и до диалога в соседней вкладке не
 * дотянуться — а до отдельного окна можно переключиться с клавиатуры (Alt+Tab).
 *
 * Вкладка подтверждения открывается ДО окна с паролем: `window.open(..., '_blank')`
 * кладёт вкладку в то окно, где жив открывающий документ, — то есть в главное.
 * Наоборот (окно с паролем первым) вкладка могла бы оказаться внутри всплывающего
 * окна и вытеснить его.
 *
 * Если браузер заблокировал всплывающее окно — остаётся запасной путь: диалог в
 * странице (он намеренно НЕ забирает фокус, `onOpenAutoFocus` отменён).
 */
export function useMinimaxTokenFlow(): MinimaxTokenFlow {
  const router = useRouter();
  const [flow, setFlow] = useState<NextTokenFlow | null>(null);
  const [phase, setPhase] = useState<TokenFlowPhase>('idle');
  const [busy, startTransition] = useTransition();
  const [pending, startPending] = useTransition();
  // Пауза между опросами обмена. Вендер сам задаёт её в `interval` (живая проба:
  // 3 секунды), а на `slow_down` просит опрашивать реже — тогда отступаем вдвое.
  const [pollMs, setPollMs] = useState(3000);
  const [passwordPrompt, setPasswordPrompt] = useState<TokenPasswordPrompt | null>(null);

  // Пока код жив — опрашиваем обмен: MiniMax отвечает «authorization_pending», пока
  // владелец не подтвердил. Как только пара получена — останавливаемся.
  useEffect(() => {
    if (!flow || phase !== 'waiting') return;
    const timer = setInterval(() => {
      void (async () => {
        const result = await claimTokenAction(flow.flow_id);
        if (!result.ok || !result.data) return;
        const claim = result.data;
        if (claim.ok) {
          setPhase('claimed');
          setFlow(null);
          toast.success(`Токен получен: аккаунт #${claim.account_id} «${claim.title}»`);
          router.refresh();
          return;
        }
        if (claim.error === 'expired_token') {
          setPhase('expired');
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
  }, [flow, phase, pollMs, router]);

  /**
   * Начать добычу. Без `accountId` — для следующего аккаунта без токена; с
   * `accountId` — для конкретного (кнопка в строке аккаунта, и сразу после
   * добавления аккаунта — мандат владельца 15.11: «пусть сразу же при добавлении
   * этого аккаунта в карман сразу же получается токен»).
   */
  function start(accountId?: number) {
    startTransition(async () => {
      const result = await nextTokenFlowAction(accountId);
      if (!result.ok || !result.data) {
        toast.error(result.ok ? 'Пустой ответ' : result.error);
        if (!result.ok && result.error.includes('Все токены')) setPhase('claimed');
        return;
      }
      const next = result.data;
      setFlow(next);
      setPhase('waiting');
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

      // 2) ПОДТВЕРЖДЕНИЕ MINIMAX — вкладкой В ТОМ ЖЕ окне браузера, где сейчас
      //    инструмент: сюда вставляется почта из буфера. Вкладку открываем
      //    ДО всплывающего окна: `window.open(..., '_blank')` кладёт вкладку в
      //    то окно, где жив открывающий документ, — а это главное окно.
      const tab = window.open(next.verification_link, '_blank');
      if (tab) {
        // Обратное tabnabbing нам не нужно: страница вендора не должна видеть
        // наше окно. `opener` — единственное, что можно занулить снаружи.
        try {
          tab.opener = null;
        } catch {
          // Браузер не дал — не страшно, на работу не влияет.
        }
      } else {
        toast.info('Браузер заблокировал новое окно — откройте ссылку подтверждения ниже');
      }

      // 3) ОКНО С ПАРОЛЕМ — отдельное окно ОС поверх браузера (как «В окне» в
      //    панели «Минимакс»): до кнопки можно дотянуться с клавиатуры, пока в
      //    соседней вкладке идёт подтверждение MiniMax. Окно переиспользуется
      //    (одно и то же имя), а не плодится на каждый аккаунт. Блокировщик
      //    всплывающих окон отдаёт запасной путь — диалог в странице.
      const passwordWindow = window.open(
        `/minimax-token-window?flow=${next.flow_id}&copied=email`,
        'karman-token-password',
        centeredWindowFeatures(
          {
            x: window.screenX,
            y: window.screenY,
            width: window.outerWidth,
            height: window.outerHeight,
          },
          TOKEN_WINDOW_SIZE,
        ),
      );
      if (!passwordWindow) {
        setPasswordPrompt({ id: next.account_id, title: next.title, email: next.email });
        toast.info('Браузер заблокировал всплывающее окно — пароль скопируйте здесь');
      }
      if (copied) {
        toast.info('Почта скопирована — вставьте её в окне MiniMax');
      }
    });
  }

  /** Забрать токен руками — на случай, если браузер уснул и опрос встал. */
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
        setPhase('claimed');
        setFlow(null);
        toast.success(`Токен получен: аккаунт #${claim.account_id} «${claim.title}»`);
        router.refresh();
      } else if (claim.error === 'expired_token') {
        setPhase('expired');
        toast.error('Код истёк — жмите «Следующий» для нового');
        router.refresh();
      } else if (claim.error === 'not_found') {
        setPhase('expired');
        toast.error('Поток не найден — жмите «Следующий»');
      }
    });
  }

  /** Отменить открытый поток (владелец передумал). */
  function cancel() {
    if (!flow) return;
    startPending(async () => {
      await cancelTokenFlowAction(flow.flow_id);
      setFlow(null);
      setPhase('idle');
      router.refresh();
    });
  }

  return {
    flow,
    phase,
    busy,
    pending,
    start,
    claimNow,
    cancel,
    passwordPrompt,
    setPasswordPrompt,
  };
}
