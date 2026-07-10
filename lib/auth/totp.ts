import { createHash, randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verifySync } from 'otplib';

/**
 * TOTP (RFC 6238) и recovery-коды — второй фактор входа (vault Ф2).
 * Чистый модуль (без `server-only`) — юнит-тестируется. Крипта — otplib v13
 * (@noble/hashes + @scure/base, аудированные), не самописная. Секрет TOTP
 * шифруется мастер-ключом на слое сервиса.
 */

// Терпимость ±30 с — рассинхрон часов телефона на один TOTP-шаг.
const EPOCH_TOLERANCE_S = 30;

const ISSUER = 'KARMAN';
const RECOVERY_COUNT = 10;

/** Новый base32-секрет TOTP (для enrollment). */
export function generateTotpSecret(): string {
  return generateSecret();
}

/** otpauth:// URI для QR-кода (Google Authenticator / Aegis / …). */
export function totpKeyUri(username: string, secret: string): string {
  return generateURI({ issuer: ISSUER, label: username, secret });
}

/** Проверка 6-значного кода против секрета (окно ±30 с). */
export function verifyTotpCode(code: string, secret: string): boolean {
  try {
    return verifySync({
      token: code.replace(/\s+/g, ''),
      secret,
      epochTolerance: EPOCH_TOLERANCE_S,
    }).valid;
  } catch {
    return false;
  }
}

/** AAD шифрования TOTP-секрета — привязка к пользователю. */
export function totpAad(userId: number): string {
  return `totp:${userId}`;
}

/** SHA-256-хэш recovery-кода (в БД только он). Код нормализуется (регистр/дефисы). */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code), 'utf8').digest('hex');
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toLowerCase().replace(/[\s-]/g, '');
}

/** Похож ли ввод на recovery-код (а не 6-значный TOTP). */
export function looksLikeRecoveryCode(input: string): boolean {
  return normalizeRecoveryCode(input).length === 10;
}

/**
 * Набор одноразовых recovery-кодов (формат `xxxxx-xxxxx`, base32 без
 * неоднозначных символов). Plaintext показывается владельцу один раз.
 */
export function generateRecoveryCodes(count = RECOVERY_COUNT): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // без i/l/o/0/1
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(10);
    const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}
