/**
 * Рендер тела напоминания для Telegram (parse_mode HTML). Чистая функция —
 * тестируется юнит-тестами. В P1 — freeform (экранируем пользовательский текст).
 * Подстановка доменных переменных {сумма}{дней}{банк}… — P4.
 */

/** Экранирование под Telegram HTML parse_mode (& < > — обязательны). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Собирает сообщение: жирный заголовок + (опц.) тело. Оба экранируются —
 * пользовательский текст не должен ломать HTML-разметку.
 */
export function renderReminderText(title: string, body: string): string {
  const head = `🔔 <b>${escapeHtml(title)}</b>`;
  const trimmed = body.trim();
  return trimmed ? `${head}\n${escapeHtml(trimmed)}` : head;
}
