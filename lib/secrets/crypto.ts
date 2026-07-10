import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Шифрование значений секретов. AES-256-GCM с мастер-ключом из env
 * (`SECRETS_MASTER_KEY`, base64 от 32 байт — `openssl rand -base64 32`).
 *
 * Чистый модуль (без `server-only`) — юнит-тестируется. Используется только на
 * сервере (сервис + API); node:crypto в клиентский бандл не попадает. Мастер-ключ
 * читается из env при каждом вызове (никогда не хранится в БД/репо). Ленивый отказ:
 * если ключ не задан, бросаем понятную ошибку только при обращении к секретам —
 * остальное приложение не зависит от этого модуля.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

function masterKey(): Buffer {
  const raw = process.env.SECRETS_MASTER_KEY?.trim();
  if (!raw) {
    throw new Error('SECRETS_MASTER_KEY не задан — менеджер секретов недоступен');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `SECRETS_MASTER_KEY должен быть base64 от ${KEY_BYTES} байт (openssl rand -base64 32)`,
    );
  }
  return key;
}

/** Корректно ли сконфигурирован мастер-ключ (для UI/health-проверки). */
export function secretsConfigured(): boolean {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}

export type EncryptedValue = { ciphertext: string; iv: string; authTag: string };

/** AAD привязывает шифротекст к его месту (нельзя переставить строку в БД). */
export function secretAad(projectId: number, key: string): string {
  return `secrets:${projectId}:${key}`;
}

/** AAD наименования карточки — привязка к id (шифруется после insert, в транзакции). */
export function cardTitleAad(cardId: number): string {
  return `secrets:card:${cardId}:title`;
}

/** AAD значения поля карточки — привязка к (карточка, имя поля). */
export function cardFieldAad(cardId: number, name: string): string {
  return `secrets:card-field:${cardId}:${name}`;
}

/** Шифрует plaintext; aad — `secretAad(projectId, key)`. Всё base64. */
export function encryptSecret(plaintext: string, aad: string): EncryptedValue {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

/** Расшифровывает; бросает при несовпадении aad или повреждении (GCM auth fail). */
export function decryptSecret(enc: EncryptedValue, aad: string): string {
  const decipher = createDecipheriv(ALGO, masterKey(), Buffer.from(enc.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(enc.authTag, 'base64'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(enc.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return pt.toString('utf8');
}
