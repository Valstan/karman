import { activateAccountAction, revealAccountPasswordAction } from '@/lib/actions/accounts';

/**
 * Активация аккаунта из браузера: копирование секрета и само гашение.
 *
 * Правило владельца: копирование почты или пароля = активация. Поэтому обе
 * операции идут одним шагом: сначала копируем (чтобы оборванное копирование
 * не сожгло аккаунт зря), потом гасим.
 *
 * Проект передаётся как `number | null | undefined`:
 * - число — «зачесть на этот проект»;
 * - null — «без проекта»;
 * - undefined — «проект не меняем» (продолжение сессии: копирование пароля
 *   после копирования почты не должно стирать выбранный проект).
 */

/** Что копируем: почту или пароль. Определяет, ну ли step-up 2FA. */
export type ActivateKind = 'email' | 'password';

export type ActivationOutcome = { ok: true } | { ok: false; error: string };

/**
 * Скопировать почту или пароль и погасить аккаунт на 24 часа.
 */
export async function copyAccountSecret(
  account: { id: number; email: string },
  kind: ActivateKind,
  projectId: number | null | undefined,
  tokens?: number,
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

  const activated = await activateAccountAction({ id: account.id, projectId, tokens });
  if (!activated.ok) return { ok: false, error: activated.error };
  return { ok: true };
}

/**
 * Погасить аккаунт без копирования — кнопка «Активировать этот аккаунт» в
 * плавающем окне: секрет в буфер не уходит, активация уходит в статистику.
 */
export async function activateAccountOnly(
  accountId: number,
  projectId: number | null | undefined,
): Promise<ActivationOutcome> {
  const activated = await activateAccountAction({ id: accountId, projectId });
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
 */
const MINIMAX_CHANNEL = 'karman-minimax';

export function publishMinimaxActivated(accountId: number): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(MINIMAX_CHANNEL);
    channel.postMessage({ type: 'activated', accountId });
    channel.close();
  } catch {
    // Канал — удобство, а не условие работы: без него активация всё равно уйдёт.
  }
}

export function subscribeMinimaxActivated(handler: (accountId: number) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(MINIMAX_CHANNEL);
  } catch {
    return () => {};
  }
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; accountId?: number } | null;
    if (data?.type === 'activated' && typeof data.accountId === 'number') handler(data.accountId);
  };
  channel.addEventListener('message', onMessage);
  return () => {
    channel.removeEventListener('message', onMessage);
    channel.close();
  };
}
