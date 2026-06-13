/**
 * Разбор Telegram callback_data "<action>:<deliveryId>[:arg]". Чистая функция
 * (без server-only) — тестируется юнит-тестами; применение действия с БД/RBAC —
 * lib/services/reminder-actions.
 */

export type CallbackParsed = { action: 'done' | 'ack' | 'snz'; deliveryId: number; arg?: string };

export function parseCallbackData(data: string): CallbackParsed | null {
  const parts = data.split(':');
  const action = parts[0] ?? '';
  const deliveryId = Number(parts[1]);
  if (action !== 'done' && action !== 'ack' && action !== 'snz') {
    return null;
  }
  if (!Number.isInteger(deliveryId) || deliveryId <= 0) {
    return null;
  }
  return { action, deliveryId, arg: parts[2] };
}
