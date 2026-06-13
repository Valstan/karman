import 'server-only';
import { linkChatByCode } from '@/lib/services/telegram-link';
import { answerCallbackQuery, sendMessage } from './client';
import type { TgMessage, TgUpdate } from './types';

/**
 * Транспорт-агностичная обработка входящего Telegram-апдейта. Вызывается из
 * /api/telegram/ingest (воркер реле). В P0: привязка `/start <code>` и справка;
 * действия кнопок (callback_query) реализует P2.
 */
export async function handleUpdate(update: TgUpdate): Promise<void> {
  if (update.message?.text) {
    await handleTextMessage(update.message);
    return;
  }
  if (update.callback_query) {
    await answerCallbackQuery({
      callbackQueryId: update.callback_query.id,
      text: 'Действия кнопок появятся в следующем обновлении.',
    });
  }
}

async function handleTextMessage(message: TgMessage): Promise<void> {
  const text = (message.text ?? '').trim();
  const chatId = message.chat.id;

  if (text.startsWith('/start')) {
    const code = text.slice('/start'.length).trim();
    if (!code) {
      await sendMessage({
        chatId,
        text:
          'Привет! Это бот напоминаний <b>KARMAN</b>. Чтобы привязать аккаунт, ' +
          'откройте ссылку привязки в разделе «Настройки» приложения.',
      });
      return;
    }
    const userId = await linkChatByCode(code, chatId, message.from?.username);
    await sendMessage({
      chatId,
      text: userId
        ? '✅ Telegram привязан к аккаунту KARMAN. Сюда будут приходить напоминания.'
        : '❌ Код привязки неверен или истёк. Сгенерируйте новую ссылку в разделе «Настройки».',
    });
    return;
  }

  await sendMessage({
    chatId,
    text: 'Команды: /start — справка. Напоминания настраиваются в приложении KARMAN.',
  });
}
