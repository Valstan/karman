import { activateAccountAction, revealAccountPasswordAction } from '@/lib/actions/accounts';

/**
 * Активация аккаунта из браузера: копирование секрета и гашение аккаунта.
 *
 * Правило владельца (05.11): **копирование почты или пароля НЕ гасит аккаунт.**
 * Гасит только явная кнопка «Активировать аккаунт» — тогда, когда владелец сам
 * решил, что аккаунт занят. Прежде копирование и было активацией, и из-за
 * этого копирование пароля после копирования почты продлевало то же окно; теперь
 * копирование ничего не трогает, а активация — ровно одно действие.
 *
 * Проект передаётся как `number | null | undefined`:
 * - число — «зачесть на этот проект»;
 * - null — «без проекта»;
 * - undefined — «проект не меняем» (продолжение сессии: активация того же
 *   аккаунта, пока окно открыто, не должна стирать выбранный проект).
 */

/** Что копируем: почту или пароль. Определяет, ну ли step-up 2FA. */
export type ActivateKind = 'email' | 'password';

export type ActivationOutcome = { ok: true } | { ok: false; error: string };

/**
 * Скопировать почту или пароль — БЕЗ гашения аккаунта (заказ владельца 05.11).
 *
 * Раньше здесь же была активация; теперь копирование ничего не меняет в
 * состоянии аккаунта и ничего не пишет в журнал активаций. Активирует отдельная
 * кнопка — `activateAccountOnly`.
 */
export async function copyAccountSecret(
  account: { id: number; email: string },
  kind: ActivateKind,
): Promise<ActivationOutcome> {
  let secret: string;
  if (kind === 'password') {
    const revealed = await revealAccountPasswordAction(account.id);
    if (!revealed.ok) return { ok: false, error: revealed.error };
    secret = revealed.data!.password;
  } else {
    secret = account.email;
  }

  try {
    await navigator.clipboard.writeText(secret);
  } catch {
    return { ok: false, error: 'Не удалось скопировать в буфер обмена' };
  }

  return { ok: true };
}

/**
 * Активировать аккаунт: открыть окно простоя на 6 часов от момента и записать
 * активацию в журнал (проект и очки уходят в статистику).
 *
 * Кнопка «Активировать этот аккаунт» в плавающем окне и «Активировать» в
 * верхнем слоте раздела — только здесь аккаунт гаснет.
 *
 * `activationIndex` — номер активации в неделе аккаунта (1..7): по нему
 * считаются очки (4-я и 7-я — 1000, остальные — 400). undefined — «определи
 * сам», по недельной квоте аккаунта.
 */
export async function activateAccountOnly(
  accountId: number,
  projectId: number | null | undefined,
  tokens?: number,
  activationIndex?: number,
): Promise<ActivationOutcome> {
  const activated = await activateAccountAction({
    id: accountId,
    projectId,
    tokens,
    activationIndex,
  });
  if (!activated.ok) return { ok: false, error: activated.error };
  return { ok: true };
}

/**
 * Шина между вкладкой раздела и плавающим окном: одно окно активировало
 * аккаунт — другое обновило список (иначе статистика на вкладке обновится
 * только после ручного обновления страницы).
 *
 * BroadcastChannel — механизм браузера, а не сервера: он ничего не пишет в БД
 * и ничего не пересылает наружу.
 *
 * Канал один на модуль и живёт, пока живёт вкладка: создавать канал на каждое
 * сообщение и сразу закрывать — лишнее (сообщение может не уйти).
 */
const MINIMAX_CHANNEL = 'karman-minimax';

let channel: BroadcastChannel | null = null;

function sharedChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) {
    try {
      channel = new BroadcastChannel(MINIMAX_CHANNEL);
    } catch {
      return null;
    }
  }
  return channel;
}

export function publishMinimaxActivated(accountId: number): void {
  const shared = sharedChannel();
  if (!shared) return;
  try {
    shared.postMessage({ type: 'activated', accountId });
  } catch {
    // Канал — удобство, а не условие работы: без него активация всё равно уйдёт.
  }
}

export function subscribeMinimaxActivated(handler: (accountId: number) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  let listener: BroadcastChannel;
  try {
    listener = new BroadcastChannel(MINIMAX_CHANNEL);
  } catch {
    return () => {};
  }
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; accountId?: number } | null;
    if (data?.type === 'activated' && typeof data.accountId === 'number') handler(data.accountId);
  };
  listener.addEventListener('message', onMessage);
  return () => {
    listener.removeEventListener('message', onMessage);
    listener.close();
  };
}
