import { timingSafeEqual } from 'node:crypto';
import { runtimeSecret } from '@/lib/ecosystem/runtime-secrets';

/**
 * Вход relay Телефона (`/api/hotline`, `/api/hotline/presence`).
 *
 * v2-a: ОДИН общий секрет на всех бэкендах-участников (`HOTLINE_RELAY_SECRET`),
 * по образцу `REMINDERS_INTERNAL_SECRET` (ingest/dispatch) и `X-Relay-Secret`
 * (karman-tg). Персональные токены комнат — v2-b: заводить выдачу токенов в том
 * же PR, что и relay, было бы двойным риском (урок G321 — две правки деплоя без
 * прогона в одном PR). До v2-b комнаты — пространства имён, не криптограница.
 *
 * Секрет — рантайм-резолвер (S1, D-119): восстановление из vault при
 * старте, env — фолбэк (см. `lib/ecosystem/runtime-secrets.ts`).
 * Отсюда — асинхронные проверки; обработчики роутов async и так.
 *
 * Fail-closed, как karman-tg: секрет не задан — эндпоинты фактически выключены
 * (роут отвечает 503, а не 401 — различаем «не настроено» и «чужой»).
 */

export async function hotlineConfigured(): Promise<boolean> {
  return (await runtimeSecret('HOTLINE_RELAY_SECRET')) !== null;
}

/**
 * Constant-time сравнение Bearer-токена запроса с общим секретом relay.
 * Возвращает false, если секрет не сконфигурирован (см. hotlineConfigured).
 */
export async function checkHotlineBearer(
  authHeader: string | null | undefined,
): Promise<boolean> {
  const secret = await runtimeSecret('HOTLINE_RELAY_SECRET');
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
