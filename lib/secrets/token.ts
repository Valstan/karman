import { createHash, randomBytes } from 'node:crypto';

/**
 * Токены доступа проектов к секретам. Сам токен показывается владельцу один раз
 * при создании; в БД хранится ТОЛЬКО SHA-256-хэш. Токен высокоэнтропийный
 * (256 бит) — перебор невозможен, проверка идёт точным поиском по хэшу.
 *
 * Чистый модуль (без `server-only`) — юнит-тестируется.
 */

const TOKEN_PREFIX = 'skm_'; // secrets-key-manager
const PREFIX_SHOWN = 12; // сколько символов токена показываем в UI для опознания

export type GeneratedToken = { token: string; prefix: string; hash: string };

/** SHA-256-хэш токена (hex) — то, что лежит в БД. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Новый токен: `skm_<base64url(32B)>`. Возвращает сам токен (показать раз), prefix и хэш. */
export function generateToken(): GeneratedToken {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, prefix: token.slice(0, PREFIX_SHOWN), hash: hashToken(token) };
}

/** Похоже ли значение на наш токен (быстрый отсев до запроса в БД). */
export function looksLikeToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX) && value.length > TOKEN_PREFIX.length + 20;
}
