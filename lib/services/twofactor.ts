import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import { toDataURL } from 'qrcode';
import { db } from '@/lib/db/client';
import { authTotp, authRecoveryCode, authAudit } from '@/lib/db/schema';
import { encryptSecret, decryptSecret } from '@/lib/secrets/crypto';
import {
  generateTotpSecret,
  totpKeyUri,
  verifyTotpCode,
  totpAad,
  generateRecoveryCodes,
  hashRecoveryCode,
  looksLikeRecoveryCode,
} from '@/lib/auth/totp';

/**
 * Второй фактор входа (vault Ф2, план docs/secrets-vault-plan.md).
 * Секрет TOTP хранится зашифрованным мастер-ключом менеджера секретов
 * (AAD от user_id); recovery-коды — только SHA-256-хэши.
 */

const isoNow = () => new Date().toISOString();

/** Аудит входов/2FA. Отдельно от secrets_audit — другой субъект (пользователь). */
export async function logAuthAudit(
  userId: number | null,
  username: string | null,
  action: string,
  ip: string | null,
): Promise<void> {
  await db.insert(authAudit).values({ userId, username, action, ip });
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
 * (plaintext возвращается ОДИН раз, в БД — хэши; старые коды удаляются).
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
    await tx
      .insert(authRecoveryCode)
      .values(codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })));
  });
  return { recoveryCodes: codes };
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
    const hash = hashRecoveryCode(input);
    const result = await db
      .update(authRecoveryCode)
      .set({ usedAt: isoNow() })
      .where(
        and(
          eq(authRecoveryCode.userId, userId),
          eq(authRecoveryCode.codeHash, hash),
          isNull(authRecoveryCode.usedAt),
        ),
      )
      .returning({ id: authRecoveryCode.id });
    return { ok: result.length > 0, usedRecovery: true };
  }

  const totp = await totpSecret(userId);
  if (!totp || !totp.enabled) return { ok: false, usedRecovery: false };
  return { ok: verifyTotpCode(input, totp.secret), usedRecovery: false };
}

/** Сколько recovery-кодов ещё не использовано (для панели настроек). */
export async function unusedRecoveryCount(userId: number): Promise<number> {
  const rows = await db
    .select({ id: authRecoveryCode.id })
    .from(authRecoveryCode)
    .where(and(eq(authRecoveryCode.userId, userId), isNull(authRecoveryCode.usedAt)));
  return rows.length;
}
