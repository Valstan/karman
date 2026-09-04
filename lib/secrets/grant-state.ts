/**
 * Состояние выдачи (grant) — одно место, где три метки времени превращаются в
 * слово, которое видят GUI владельца и машинный API (`state` в ответах).
 *
 * Двусторонний grant (мандат brain 2026-09-03, D-061): источник ПРЕДЛАГАЕТ
 * выдачу, получатель ПРИНИМАЕТ. До принятия строка — предложение: в
 * `GET /api/secrets` получателя не входит, значения не даёт, имя не занимает.
 *
 * Чистый модуль (без `server-only`): используется в сервисах, компонентах и тестах.
 */

export type GrantState = 'pending' | 'active' | 'revoked';

export type GrantTimestamps = {
  acceptedAt: string | null;
  revokedAt: string | null;
};

/**
 * Отзыв старше принятия: отозванное предложение — тоже `revoked`, а не «висящее
 * предложение», иначе получатель принял бы то, что источник уже забрал.
 */
export function grantState(g: GrantTimestamps): GrantState {
  if (g.revokedAt) return 'revoked';
  if (!g.acceptedAt) return 'pending';
  return 'active';
}

/** Даёт ли выдача значение получателю: только принятая и не отозванная. */
export function grantDelivers(g: GrantTimestamps): boolean {
  return grantState(g) === 'active';
}
