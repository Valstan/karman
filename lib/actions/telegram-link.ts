'use server';

import { getBotUsername, telegramConfigured } from '@/lib/telegram/config';
import { generateLinkCode } from '@/lib/services/telegram-link';
import { currentUserOrNull, type ActionResult } from './_internal';

export type LinkCodeResult = { code: string; botUsername: string; deepLink: string };

/**
 * Генерирует одноразовый код привязки Telegram и собирает deep-link
 * `https://t.me/<bot>?start=<code>`. Пользователь жмёт ссылку → бот ловит
 * `/start <code>` (через воркер) → привязывает chat_id.
 */
export async function generateTelegramLinkAction(): Promise<ActionResult<LinkCodeResult>> {
  const user = await currentUserOrNull();
  if (!user) {
    return { ok: false, error: 'Требуется авторизация' };
  }
  if (!telegramConfigured()) {
    return { ok: false, error: 'Telegram-бот не настроен на сервере' };
  }
  const botUsername = getBotUsername();
  if (!botUsername) {
    return { ok: false, error: 'TELEGRAM_BOT_USERNAME не задан на сервере' };
  }

  const code = await generateLinkCode(user.id);
  return {
    ok: true,
    data: { code, botUsername, deepLink: `https://t.me/${botUsername}?start=${code}` },
  };
}
