/**
 * Минимальные типы Telegram Bot API — только поля, которые мы реально читаем/шлём.
 * Чистые типы (без server-only): используются и в роутах, и в тестах.
 * Полная схема: https://core.telegram.org/bots/api
 */

export type TgUser = {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
};

export type TgChat = {
  id: number;
  type: string;
  username?: string;
};

export type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
};

export type TgCallbackQuery = {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
};

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
};

export type TgInlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

export type TgInlineKeyboard = { inline_keyboard: TgInlineButton[][] };

export type TgParseMode = 'HTML' | 'MarkdownV2';

export type SendMessageParams = {
  chatId: number;
  text: string;
  parseMode?: TgParseMode;
  replyMarkup?: TgInlineKeyboard;
  disableNotification?: boolean;
};

/** Результат вызова Bot API: классифицированный, чтобы диспетчер решал retry/skip. */
export type TgResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; kind: 'rate_limited'; retryAfter: number; description: string }
  | { ok: false; kind: 'blocked'; description: string } // 403 — чат недоступен
  | { ok: false; kind: 'bad_request'; description: string } // 4xx
  | { ok: false; kind: 'network'; description: string }; // сеть/5xx
