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

/**
 * Break-glass-выключатель (ADR-0012 §7). С волной 2 штатный вход — паспорт CI,
 * а общий ключ остаётся единственным путём восстановления, если паспортный
 * сломается. Убирать его нельзя, но использование должно стать редким и
 * заметным. Выключается явным `PROVISION_KEY_ENABLED=false` — так волна 5
 * («выключение PROVISION_KEY_ENABLED») закрывается одной переменной, без
 * выкатки кода. Умолчание пока «включён»: паспорт ещё не прошёл пилот, и
 * молчаливое выключение живого канала было бы поломкой, а не ужесточением.
 */
function provisionKeyEnabled(): boolean {
  const raw = process.env.PROVISION_KEY_ENABLED?.trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

function configuredKey(): string | null {
  if (!provisionKeyEnabled()) return null;
  const raw = process.env.VAULT_PROVISION_KEY?.trim();
  return raw && raw.length >= MIN_KEY_LENGTH ? raw : null;
}

/** Задан ли provisioning-ключ достаточной длины (≥ 32 символов) и не выключен ли он. */
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
