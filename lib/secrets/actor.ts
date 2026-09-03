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

/**
 * Комната как принципал (D-061, второй ход): выдача/отзыв grant машинным путём под
 * токеном комнаты-источника. «Кто» здесь — комната, а не владелец и не удостоверение;
 * что именно предъявили (паспорт/токен) — в detail строки.
 */
export function actorRoom(slug: string): string {
  return `room:${slug}`.slice(0, 120);
}

/** Операция самого сервиса (фоновые задачи, self-serve provisioning). */
export const ACTOR_SYSTEM = 'system';
