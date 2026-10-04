import { timingSafeEqual } from 'node:crypto';

/**
 * Вход relay Телефона (`/api/hotline`, `/api/hotline/presence`).
 *
 * v2-a: ОДИН общий секрет на всех бэкендов-участников (`HOTLINE_RELAY_SECRET`),
 * по образцу `REMINDERS_INTERNAL_SECRET` (ingest/dispatch) и `X-Relay-Secret`
 * (karman-tg). Персональные токены комнат — v2-b: заводить выдачу токенов в том
 * же PR, что и relay, было бы двойным риском (урок G321 — две правки деплоя без
 * прогона в одном PR). До v2-b комнаты — пространства имён, не криптограница.
 *
 * Fail-closed, как karman-tg: секрет не задан — эндпоинты фактически выключены
 * (роут отвечает 503, а не 401 — различаем «не настроено» и «чужой»).
 */

export function hotlineConfigured(): boolean {
  return Boolean(process.env.HOTLINE_RELAY_SECRET);
}

/**
 * Constant-time сравнение Bearer-токена запроса с общим секретом relay.
 * Возвращает false, если секрет не сконфигурирован (см. hotlineConfigured).
 */
export function checkHotlineBearer(authHeader: string | null | undefined): boolean {
  const secret = process.env.HOTLINE_RELAY_SECRET ?? '';
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
