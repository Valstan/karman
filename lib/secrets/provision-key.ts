import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Provisioning-ключ self-serve onboarding'а (`VAULT_PROVISION_KEY`, мандат brain
 * 2026-07-12, амендмент §6 ADR-0006). Отдельный секрет #008-класса: даёт ТОЛЬКО
 * право завести новую комнату + её rw-токен, не даёт чтения чужих ячеек и не
 * связан с мастер-ключом шифрования.
 *
 * Чистый модуль (без `server-only`) — юнит-тестируется. Ключ читается из env при
 * каждом вызове; слабый (короткий) ключ считается несконфигурированным — эндпойнт
 * отвечает 503, а не работает с деградированной защитой.
 */

const MIN_KEY_LENGTH = 32;

function configuredKey(): string | null {
  const raw = process.env.VAULT_PROVISION_KEY?.trim();
  return raw && raw.length >= MIN_KEY_LENGTH ? raw : null;
}

/** Задан ли provisioning-ключ достаточной длины (≥ 32 символов). */
export function provisionKeyConfigured(): boolean {
  return configuredKey() !== null;
}

/** Совпадает ли кандидат с ключом. Сравнение хэшей — постоянное время, любые длины. */
export function checkProvisionKey(candidate: string): boolean {
  const key = configuredKey();
  if (!key) return false;
  const a = createHash('sha256').update(candidate, 'utf8').digest();
  const b = createHash('sha256').update(key, 'utf8').digest();
  return timingSafeEqual(a, b);
}
