/**
 * Разбор ошибок Postgres по SQLSTATE.
 *
 * Чистый модуль без БД: используется и в server actions, и в сервисах, и в тестах.
 */

/**
 * `23505 unique_violation` — единственный надёжный признак гонки на уникальном
 * индексе. Предпроверка «а нет ли уже такой строки?» и сам INSERT не атомарны:
 * между ними успевает вставиться параллельный запрос. Предпроверка нужна ради
 * ВНЯТНОГО текста ошибки, а не ради корректности; корректность даёт индекс,
 * и его отказ надо ловить.
 *
 * `onConflictDoNothing` заменой не служит там, где индекс ЧАСТИЧНЫЙ
 * (`... WHERE revoked_at IS NULL`): Postgres на такой target отвечает `42P10`.
 *
 * SQLSTATE может лежать на двух уровнях: напрямую у ошибки драйвера (pg)
 * и в `.cause` — drizzle оборачивает ошибку драйвера в `DrizzleQueryError`
 * (свой `message` — текст запроса, оригинал — в `cause`). Не смотреть
 * `cause` — значит ловить гонки только в тестах на голом драйвере, а в
 * проде превращать их в 500.
 */
export function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: string; cause?: { code?: string } };
  return err.code === '23505' || err.cause?.code === '23505';
}
