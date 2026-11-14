'use server';

import {
  cancelTokenFlow,
  claimToken,
  startNextTokenFlow,
  tokenProgress,
  type ClaimResult,
  type NextTokenFlow,
  type TokenProgress,
} from '@/lib/services/account-tokens';
import { currentUserOrNull, revalidateAll, type ActionResult } from './_internal';

/**
 * Токены аккаунтов MiniMax — действия владельца (заказ владельца 14.11).
 *
 * Сценарий владельца: заходит в раздел, жмёт «Следующий», открывает ссылку
 * MiniMax, входит и подтверждает; страница сама дожидается обмена кода и кладёт пару
 * токенов в базу. Аккаунты с уже добытым токеном пропускаются; когда токены есть у
 * всех — процесс останавливается и говорит об этом.
 *
 * Раздел только владельца (там токены агента): проверка — и в действиях, и на
 * странице; отказ — 404, как у раздела секретов.
 */

/** Прогресс: сколько токенов добыто, сколько осталось, состояние по аккаунтам. */
export async function tokenProgressAction(): Promise<ActionResult<TokenProgress>> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  if (!user.isSuperuser) return { ok: false, error: 'Раздел доступен только владельцу' };
  const progress = await tokenProgress(user);
  return { ok: true, data: progress };
}

/** «Следующий» — завести device-flow для следующего аккаунта без токена. */
export async function nextTokenFlowAction(): Promise<ActionResult<NextTokenFlow>> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  if (!user.isSuperuser) return { ok: false, error: 'Раздел доступен только владельцу' };
  const started = await startNextTokenFlow(user);
  if (!started.ok) {
    if (started.error === 'complete') {
      return { ok: false, error: 'Все токены получены — процесс завершён' };
    }
    return { ok: false, error: started.message ?? 'MiniMax не ответил' };
  }
  revalidateAll();
  return { ok: true, data: started.flow };
}

/**
 * Забрать токен: обменять подтверждённый код на пару и положить её в базу.
 *
 * Пока владелец не подтвердил — MiniMax отдаёт `authorization_pending`; это не
 * ошибка, а «жди», поэтому страница опрашивает действие раз в интервал.
 */
export async function claimTokenAction(flowId: number): Promise<ActionResult<ClaimResult>> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  if (!user.isSuperuser) return { ok: false, error: 'Раздел доступен только владельцу' };
  const claimed = await claimToken(user, flowId);
  if (claimed.ok) revalidateAll();
  return { ok: true, data: claimed };
}

/** Отменить открытый flow (владелец передумал или код выдохся). */
export async function cancelTokenFlowAction(flowId: number): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  if (!user.isSuperuser) return { ok: false, error: 'Раздел доступен только владельцу' };
  await cancelTokenFlow(user, flowId);
  revalidateAll();
  return { ok: true };
}
