import 'server-only';
import { getBotToken } from './config';
import type { SendMessageParams, TgInlineKeyboard, TgResult } from './types';

/**
 * Исходящий клиент Telegram Bot API (только то, что шлёт KARMAN). Входящие тянет
 * отдельный воркер (scripts/reminders-worker.mjs) через getUpdates и реле в
 * /api/telegram/ingest — здесь getUpdates нет намеренно.
 */

// База Bot API. По умолчанию api.telegram.org, НО на прод-боксе (myjino, РФ) IP
// Telegram заблокированы RKN — там TELEGRAM_API_BASE указывает на relay вне блока
// (напр. Cloudflare Worker). Реле проксирует /bot<token>/<method> на api.telegram.org.
// См. docs/telegram-reminders.md.
const API_BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');

type TgApiEnvelope<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
};

async function callMethod<T>(method: string, params: Record<string, unknown>): Promise<TgResult<T>> {
  const token = getBotToken();
  if (!token) {
    return { ok: false, kind: 'bad_request', description: 'TELEGRAM_BOT_TOKEN не задан' };
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
  } catch (error) {
    return { ok: false, kind: 'network', description: String(error) };
  }

  let body: TgApiEnvelope<T>;
  try {
    body = (await res.json()) as TgApiEnvelope<T>;
  } catch {
    return { ok: false, kind: 'network', description: `Не JSON, HTTP ${res.status}` };
  }

  if (body.ok && body.result !== undefined) {
    return { ok: true, result: body.result };
  }

  const description = body.description ?? `HTTP ${res.status}`;
  if (res.status === 429) {
    return {
      ok: false,
      kind: 'rate_limited',
      retryAfter: body.parameters?.retry_after ?? 1,
      description,
    };
  }
  if (res.status === 403) {
    return { ok: false, kind: 'blocked', description };
  }
  if (res.status >= 500) {
    return { ok: false, kind: 'network', description };
  }
  return { ok: false, kind: 'bad_request', description };
}

export type SentMessage = { message_id: number; chat: { id: number } };

export function sendMessage(params: SendMessageParams): Promise<TgResult<SentMessage>> {
  return callMethod<SentMessage>('sendMessage', {
    chat_id: params.chatId,
    text: params.text,
    parse_mode: params.parseMode ?? 'HTML',
    reply_markup: params.replyMarkup,
    disable_notification: params.disableNotification ?? false,
    link_preview_options: { is_disabled: true },
  });
}

export function answerCallbackQuery(args: {
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
}): Promise<TgResult<boolean>> {
  return callMethod<boolean>('answerCallbackQuery', {
    callback_query_id: args.callbackQueryId,
    text: args.text,
    show_alert: args.showAlert ?? false,
  });
}

export function editMessageReplyMarkup(args: {
  chatId: number;
  messageId: number;
  replyMarkup?: TgInlineKeyboard;
}): Promise<TgResult<unknown>> {
  return callMethod('editMessageReplyMarkup', {
    chat_id: args.chatId,
    message_id: args.messageId,
    reply_markup: args.replyMarkup ?? { inline_keyboard: [] },
  });
}
