import 'server-only';
import { timingSafeEqual } from 'node:crypto';

/**
 * Ленивый резолв секретов Telegram/воркера — по образцу getSecretKey() в
 * lib/auth/jwt.ts: top-level throw сломал бы `next build` (Collecting page data
 * с NODE_ENV=production без рантайм-секрета). Fail-fast — при первом обращении.
 *
 * Веб-приложение НЕ падает без этих переменных (раздел кредитов/документов
 * самодостаточен): фичу напоминаний просто нельзя использовать, пока не настроено.
 */

let cachedToken: string | null = null;

export function getBotToken(): string {
  if (cachedToken !== null) {
    return cachedToken;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token && process.env.NODE_ENV === 'production') {
    throw new Error('TELEGRAM_BOT_TOKEN must be set to use Telegram reminders in production');
  }
  cachedToken = token ?? '';
  return cachedToken;
}

/** Бот настроен (есть токен) — UI/роуты деградируют мягко, если нет. */
export function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

/** Имя бота для deep-link `t.me/<bot>?start=<code>` (без @). */
export function getBotUsername(): string {
  return (process.env.TELEGRAM_BOT_USERNAME ?? '').replace(/^@/, '');
}

/** Общий секрет воркер ↔ Next-роуты (/api/telegram/ingest, /api/reminders/dispatch). */
export function getInternalSecret(): string {
  return process.env.REMINDERS_INTERNAL_SECRET ?? '';
}

/**
 * Constant-time сравнение Bearer-токена запроса с общим секретом. Возвращает
 * false, если секрет не сконфигурирован (эндпоинт фактически выключен).
 */
export function checkInternalBearer(authHeader: string | null | undefined): boolean {
  const secret = getInternalSecret();
  if (!secret) {
    return false;
  }
  const prefix = 'Bearer ';
  if (!authHeader || !authHeader.startsWith(prefix)) {
    return false;
  }
  const provided = Buffer.from(authHeader.slice(prefix.length));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}
