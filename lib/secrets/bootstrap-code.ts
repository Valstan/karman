import { createHash, randomBytes } from 'node:crypto';

/**
 * Одноразовый bootstrap-код комнаты («времянка»). Владелец выпускает его, называет
 * проекту вслух/в чате, проект меняет на токен своей комнаты — и код гаснет.
 *
 * Префикс `skb_` намеренно отличается от `skm_` рабочих токенов: утёкшую строку
 * видно по первым четырём символам, и её класс («одноразовая, живёт минуты»)
 * читается без обращения к БД. В логах и чатах это различие — половина разбора.
 *
 * Энтропия 192 бита: код живёт минуты, но подбор всё равно должен быть
 * невозможен, а не «маловероятен за время жизни».
 *
 * Чистый модуль (без `server-only`) — юнит-тестируется.
 */

const CODE_PREFIX = 'skb_'; // secrets-key-bootstrap
const PREFIX_SHOWN = 12;

/** Срок жизни времянки по умолчанию и допустимые границы (минуты). */
export const BOOTSTRAP_TTL_DEFAULT_MINUTES = 30;
export const BOOTSTRAP_TTL_MIN_MINUTES = 5;
export const BOOTSTRAP_TTL_MAX_MINUTES = 1440;

export type GeneratedBootstrapCode = { code: string; prefix: string; hash: string };

/** SHA-256-хэш кода (hex) — то, что лежит в БД. */
export function hashBootstrapCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** Новый код: `skb_<base64url(24B)>`. Возвращает сам код (показать раз), prefix и хэш. */
export function generateBootstrapCode(): GeneratedBootstrapCode {
  const code = `${CODE_PREFIX}${randomBytes(24).toString('base64url')}`;
  return { code, prefix: code.slice(0, PREFIX_SHOWN), hash: hashBootstrapCode(code) };
}

/** Похоже ли значение на времянку (быстрый отсев до запроса в БД). */
export function looksLikeBootstrapCode(value: string): boolean {
  return value.startsWith(CODE_PREFIX) && value.length > CODE_PREFIX.length + 20;
}

/** Срок в допустимых границах; мусор и выход за границы — к дефолту/краю, а не к ошибке. */
export function clampTtlMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return BOOTSTRAP_TTL_DEFAULT_MINUTES;
  return Math.min(BOOTSTRAP_TTL_MAX_MINUTES, Math.max(BOOTSTRAP_TTL_MIN_MINUTES, Math.trunc(minutes)));
}
