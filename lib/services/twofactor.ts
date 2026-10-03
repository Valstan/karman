import 'server-only';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { toDataURL } from 'qrcode';
import { db } from '@/lib/db/client';
import { authTotp, authRecoveryCode, authAudit, authUser } from '@/lib/db/schema';
import { encryptSecret, decryptSecret } from '@/lib/secrets/crypto';
import {
  generateTotpSecret,
  totpKeyUri,
  verifyTotpCode,
  totpAad,
  generateRecoveryCodes,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  newRecoverySalt,
} from '@/lib/auth/totp';

/**
 * Второй фактор входа (vault Ф2, план docs/secrets-vault-plan.md).
 * Секрет TOTP хранится зашифрованным мастер-ключом менеджера секретов
 * (AAD от user_id); recovery-коды — только SHA-256-хэши.
 */

const isoNow = () => new Date().toISOString();

/**
 * Аудит входов/2FA. Отдельно от secrets_audit — другой субъект (пользователь).
 *
 * Обрезка — ЗДЕСЬ, а не в вызывающих: `username` — `varchar(150)`, `ip` — `varchar(64)`,
 * а `loginSchema` задаёт логину только `.min(1)` без верхней границы. Анонимный
 * `POST /api/auth/login` с логином длиннее 150 символов ронял INSERT (PG 22001), и вместо
 * 401 наружу уходил 500 (аудит #057, D4). Тот же класс уже лечили в вызывающем коде для
 * почты ЕСА (`oidc/callback`: `.slice(0, 150)`) — то есть вывод сделали, но не туда, откуда
 * он защищает всех.
 */
export async function logAuthAudit(
  userId: number | null,
  username: string | null,
  action: string,
  ip: string | null,
): Promise<void> {
  await db.insert(authAudit).values({
    userId,
    username: username === null ? null : username.slice(0, 150),
    action,
    ip: ip === null ? null : ip.slice(0, 64),
  });
}

/** Включён ли 2FA у пользователя (enrollment подтверждён кодом). */
export async function totpEnabled(userId: number): Promise<boolean> {
  const [row] = await db
    .select({ enabledAt: authTotp.enabledAt })
    .from(authTotp)
    .where(eq(authTotp.userId, userId))
    .limit(1);
  return Boolean(row?.enabledAt);
}

/**
 * Растить поколение сессии (аудит #057 R2, миграция 0019).
 *
 * Вызывается из операций, меняющих безопасность учётки. Рост означает, что ВСЕ ранее выданные
 * токены этой учётки перестают проходить сверку в `getCurrentUser` — то есть операция, которой
 * человек чинит последствия кражи, теперь эти последствия закрывает.
 *
 * Порядок вызывающих важен: сначала инкремент, потом `rotateSessionCookie` — она читает
 * поколение из БД, поэтому до инкремента перевыпустила бы токен старого поколения.
 */
export async function bumpSessionEpoch(userId: number): Promise<void> {
  await db
    .update(authUser)
    .set({ sessionEpoch: sql`${authUser.sessionEpoch} + 1` })
    .where(eq(authUser.id, userId));
}

export type TotpEnrollment = { otpauthUri: string; qrDataUrl: string; secret: string };

/**
 * Начинает enrollment: генерирует секрет, пишет его зашифрованным (enabled_at
 * NULL — не активен), возвращает QR + секрет для ручного ввода. Повторный вызов
 * до подтверждения перегенерирует секрет. Включённый 2FA не трогает.
 */
export async function startTotpEnrollment(
  userId: number,
  username: string,
): Promise<TotpEnrollment | null> {
  if (await totpEnabled(userId)) return null;
  const secret = generateTotpSecret();
  const enc = encryptSecret(secret, totpAad(userId));
  await db
    .insert(authTotp)
    .values({ userId, secretCt: enc.ciphertext, secretIv: enc.iv, secretTag: enc.authTag })
    .onConflictDoUpdate({
      target: authTotp.userId,
      set: { secretCt: enc.ciphertext, secretIv: enc.iv, secretTag: enc.authTag, enabledAt: null },
    });
  const otpauthUri = totpKeyUri(username, secret);
  const qrDataUrl = await toDataURL(otpauthUri, { margin: 1, width: 220 });
  return { otpauthUri, qrDataUrl, secret };
}

/** Расшифрованный секрет TOTP пользователя (или null). */
async function totpSecret(userId: number): Promise<{ secret: string; enabled: boolean } | null> {
  const [row] = await db.select().from(authTotp).where(eq(authTotp.userId, userId)).limit(1);
  if (!row) return null;
  return {
    secret: decryptSecret(
      { ciphertext: row.secretCt, iv: row.secretIv, authTag: row.secretTag },
      totpAad(userId),
    ),
    enabled: Boolean(row.enabledAt),
  };
}

/**
 * Подтверждает enrollment первым кодом: включает 2FA и выпускает recovery-коды
 * (plaintext возвращается ОДИН раз, в БД — хэш с солью; старые коды удаляются).
 */
export async function confirmTotpEnrollment(
  userId: number,
  code: string,
): Promise<{ recoveryCodes: string[] } | null> {
  const totp = await totpSecret(userId);
  if (!totp || totp.enabled || !verifyTotpCode(code, totp.secret)) return null;

  const codes = generateRecoveryCodes();
  await db.transaction(async (tx) => {
    await tx.update(authTotp).set({ enabledAt: isoNow() }).where(eq(authTotp.userId, userId));
    await tx.delete(authRecoveryCode).where(eq(authRecoveryCode.userId, userId));
    await tx.insert(authRecoveryCode).values(codes.map((c) => storedRecoveryCode(userId, c)));
  });
  return { recoveryCodes: codes };
}

/**
 * Перевыпуск recovery-кодов по кнопке в настройках (аудит #057 S2, решение владельца
 * 2026-10-03 — «выдавать заново»).
 *
 * Требует действующий TOTP-код: операция НЕ меняет сам второй фактор, но выдаёт новый
 * запасной путь, то есть меняет то, чем человек восстанавливается при потере телефона. Без
 * кода её выполнил бы тот, у кого уже есть сессия, — а украденная сессия это ровно то, от
 * чего мы закрываемся.
 *
 * Старые коды перестают работать сразу: удаление и вставка идут в одной транзакции, иначе
 * при падении на вставке человек остался бы вообще без запасного пути, то есть потерял бы
 * второй фактор из-за ошибки на нашей стороне.
 */
export async function regenerateRecoveryCodes(
  userId: number,
  code: string,
): Promise<{ recoveryCodes: string[] } | null> {
  const totp = await totpSecret(userId);
  if (!totp || !totp.enabled || !verifyTotpCode(code, totp.secret)) return null;

  const codes = generateRecoveryCodes();
  await db.transaction(async (tx) => {
    await tx.delete(authRecoveryCode).where(eq(authRecoveryCode.userId, userId));
    await tx.insert(authRecoveryCode).values(codes.map((c) => storedRecoveryCode(userId, c)));
  });
  return { recoveryCodes: codes };
}

/** Строка таблицы под новый код: своя соль на каждый код. */
function storedRecoveryCode(userId: number, code: string) {
  const codeSalt = newRecoverySalt();
  return { userId, codeHash: hashRecoveryCode(code, codeSalt), codeSalt };
}

/** Отключает 2FA (требует действующий TOTP-код). Удаляет секрет и recovery-коды. */
export async function disableTotp(userId: number, code: string): Promise<boolean> {
  const totp = await totpSecret(userId);
  if (!totp || !totp.enabled || !verifyTotpCode(code, totp.secret)) return false;
  await db.transaction(async (tx) => {
    await tx.delete(authRecoveryCode).where(eq(authRecoveryCode.userId, userId));
    await tx.delete(authTotp).where(eq(authTotp.userId, userId));
  });
  return true;
}

/**
 * Проверка второго фактора при входе: 6-значный TOTP-код или одноразовый
 * recovery-код (помечается использованным).
 */
export async function verifySecondFactor(
  userId: number,
  input: string,
): Promise<{ ok: boolean; usedRecovery: boolean }> {
  if (looksLikeRecoveryCode(input)) {
    // У каждой строки своя соль (аудит #057 S2), поэтому хэш нельзя посчитать один раз на
    // ввод: считаем против соли КАЖДОЙ строки пользователя. Строк десять, цена — десять
    // pbkdf2, и это единственный способ не хранить соль в одной строке с хэшем.
    const candidates = await db
      .select({
        id: authRecoveryCode.id,
        codeHash: authRecoveryCode.codeHash,
        codeSalt: authRecoveryCode.codeSalt,
      })
      .from(authRecoveryCode)
      .where(and(eq(authRecoveryCode.userId, userId), isNull(authRecoveryCode.usedAt)));

    for (const row of candidates) {
      if (!sameDigest(hashRecoveryCode(input, row.codeSalt), row.codeHash)) continue;
      // Одноразовость и гонку закрывает условный UPDATE, а не найденная строка: два
      // одновременных ввода с одним кодом оба нашли бы строку, но помечен будет ровно один.
      const claimed = await db
        .update(authRecoveryCode)
        .set({ usedAt: isoNow() })
        .where(and(eq(authRecoveryCode.id, row.id), isNull(authRecoveryCode.usedAt)))
        .returning({ id: authRecoveryCode.id });
      if (claimed.length > 0) return { ok: true, usedRecovery: true };
    }
    return { ok: false, usedRecovery: true };
  }

  const totp = await totpSecret(userId);
  if (!totp || !totp.enabled) return { ok: false, usedRecovery: false };
  return { ok: verifyTotpCode(input, totp.secret), usedRecovery: false };
}

/** Сравнение хэшей постоянного времени: длины равны (64 hex), ранний выход ничего не даёт. */
function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Сколько recovery-кодов ещё не использовано (для панели настроек). */
export async function unusedRecoveryCount(userId: number): Promise<number> {
  const rows = await db
    .select({ id: authRecoveryCode.id })
    .from(authRecoveryCode)
    .where(and(eq(authRecoveryCode.userId, userId), isNull(authRecoveryCode.usedAt)));
  return rows.length;
}
