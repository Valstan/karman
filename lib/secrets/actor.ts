/**
 * Актор аудита — «кто», а не «что предъявили» (долг ADR-0012 §6: GUI-операции
 * владельца не аудировались вовсе, колонки актора в аудите не было).
 *
 * Формат — префикс класса + идентификатор, чтобы строку можно было
 * фильтровать без разбора смысла: `owner:1`, `passport:Valstan/trener`,
 * `token:skm_AbCd…`, `system`.
 *
 * Чистый модуль (без `server-only`): используется и в сервисах, и в тестах.
 */

/** Владелец из живой сессии GUI (второй фактор уже пройден гейтом /secrets). */
export function actorOwner(userId: number): string {
  return `owner:${userId}`;
}

/** Паспортная сессия: метка личности из реестра, а не из самого удостоверения. */
export function actorPassport(label: string): string {
  return `passport:${label}`.slice(0, 120);
}

/** Машинный доступ статическим токеном комнаты — по префиксу, значение не логируем. */
export function actorToken(tokenPrefix: string): string {
  return `token:${tokenPrefix}`;
}

/** Операция самого сервиса (фоновые задачи, self-serve provisioning). */
export const ACTOR_SYSTEM = 'system';
