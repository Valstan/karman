import type { TgInlineKeyboard } from './types';

/**
 * Inline-клавиатура напоминания. callback_data компактно (лимит Telegram 64 байта):
 * "<action>:<deliveryId>[:arg]". Обработка — lib/services/reminder-actions.
 * Доменные кнопки («Отметить оплаченным») добавит P4.
 */
export function buildReminderKeyboard(deliveryId: number): TgInlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '✓ Готово', callback_data: `done:${deliveryId}` },
        { text: '⏰ +1 час', callback_data: `snz:${deliveryId}:1h` },
      ],
      [{ text: '⏰ Завтра 9:00', callback_data: `snz:${deliveryId}:tmrw` }],
    ],
  };
}
