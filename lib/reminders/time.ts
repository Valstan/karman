/**
 * Конвертация времени для напоминаний. Wall-clock в спеке расписания — московский
 * (Europe/Moscow, фиксированный UTC+3 с 2014 г., без DST); храним и сравниваем —
 * UTC-инстанты. Чистые функции (без server-only) — тестируются юнит-тестами.
 *
 * НЕ переиспользуем lib/dates.ts: та работает с process-local временем и строками
 * дат без таймзоны — другой контракт.
 */

const MOSCOW_OFFSET_MINUTES = 3 * 60; // UTC+3, фиксировано

/**
 * Московский локальный момент 'YYYY-MM-DDTHH:MM' → ISO-строка UTC-инстанта.
 * Пример: '2026-06-20T09:00' → '2026-06-20T06:00:00.000Z'.
 */
export function moscowLocalToUtcIso(local: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!match) {
    throw new Error(`Некорректный московский момент: ${local}`);
  }
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  const h = Number(match[4]);
  const mi = Number(match[5]);
  const utcMs = Date.UTC(y, mo - 1, d, h, mi) - MOSCOW_OFFSET_MINUTES * 60_000;
  return new Date(utcMs).toISOString();
}

/** UTC-инстант (ISO/Date) → московский wall-clock 'YYYY-MM-DDTHH:MM'. */
export function utcToMoscowLocal(utc: string | Date): string {
  const ms = (typeof utc === 'string' ? new Date(utc) : utc).getTime() + MOSCOW_OFFSET_MINUTES * 60_000;
  return new Date(ms).toISOString().slice(0, 16);
}
