import { timingSafeEqual } from 'node:crypto';
import { runtimeSecret } from '@/lib/ecosystem/runtime-secrets';

/**
 * Вход машинного канала промтов (`/api/prompts`).
 *
 * Канал один: Мозг складывает надиктованные промты по проектам (заказ владельца
 * 2026-11-06). Записывает их Мозг, а смотрит и чистит владелец — из интерфейса
 * КАРМАНА, по своей сессии.
 *
 * Почему ОТДЕЛЬНЫЙ секрет, а не `HOTLINE_RELAY_SECRET` (общий ключ relay Телефона):
 * промт из этой библиотеки копируется в буфер и уходит в нейронку — то есть
 * прямо в рабочий контекст владельца и его разработчиков. Секрет relay'а знают
 * все бэкенды-участники комнаты, и выдавать им право писать в библиотеку
 * промтов незачем. Здесь ключ только у Мозга и у владельца.
 *
 * Секрет — рантайм-резолвер (S1, D-119): восстановление из vault при старте,
 * env — фолбэк (см. `lib/ecosystem/runtime-secrets.ts`). Отсюда асинхронные
 * проверки; обработчики роутов async и так.
 *
 * Fail-closed, как relay Телефона: секрет не задан — эндпоинт фактически
 * выключен (503 «не настроено», а не 401 — различаем «не настроено» и «чужой»).
 */

export async function promptsConfigured(): Promise<boolean> {
  return (await runtimeSecret('PROMPTS_INGEST_SECRET')) !== null;
}

/**
 * Constant-time сравнение Bearer-токена запроса с секретом канала промтов.
 * Возвращает false, если секрет не сконфигурирован (см. promptsConfigured).
 */
export async function checkPromptsBearer(
  authHeader: string | null | undefined,
): Promise<boolean> {
  const secret = await runtimeSecret('PROMPTS_INGEST_SECRET');
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
