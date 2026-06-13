import 'server-only';
import { linkChatByCode } from '@/lib/services/telegram-link';
import { applyReminderCallback } from '@/lib/services/reminder-actions';
import { parseCallbackData } from '@/lib/reminders/callback';
import { answerCallbackQuery, editMessageReplyMarkup, sendMessage } from './client';
import type { TgCallbackQuery, TgMessage, TgUpdate } from './types';

/**
 * Транспорт-агностичная обработка входящего Telegram-апдейта. Вызывается из
 * /api/telegram/ingest (воркер реле): привязка `/start <code>`, справка и
 * действия кнопок (callback_query → done/snooze с RBAC и идемпотентностью).
 */
export async function handleUpdate(update: TgUpdate): Promise<void> {
  if (update.message?.text) {
    await handleTextMessage(update.message);
    return;
  }
  if (update.callback_query) {
    await handleCallback(update.callback_query);
  }
}

async function handleCallback(cq: TgCallbackQuery): Promise<void> {
  const parsed = parseCallbackData(cq.data ?? '');
  if (!parsed) {
    await answerCallbackQuery({ callbackQueryId: cq.id, text: 'Неизвестное действие' });
    return;
  }
  const chatId = cq.message?.chat.id ?? cq.from.id;
  const outcome = await applyReminderCallback(parsed, chatId, cq.id);
  await answerCallbackQuery({ callbackQueryId: cq.id, text: outcome.answer });
  if (outcome.clearKeyboard && cq.message) {
    // Гасим кнопки, чтобы нельзя было нажать повторно (подтверждение — в тосте выше).
    await editMessageReplyMarkup({ chatId, messageId: cq.message.message_id });
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
