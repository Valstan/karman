import 'server-only';
import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { authUser } from '@/lib/db/schema';
import { hashDjangoPassword, verifyDjangoPassword } from '@/lib/auth/password';
import { logAuthAudit } from '@/lib/services/twofactor';
import type { SessionUser } from '@/lib/auth/rbac';

/**
 * Управление аккаунтами (восстановление доступа): список пользователей и сброс
 * пароля — только superuser; смена собственного пароля — любой пользователь.
 * Сброс НЕ обходит 2FA: временный пароль — только первый фактор входа.
 */

export type AccountListItem = {
  id: number;
  username: string;
  isSuperuser: boolean;
  isActive: boolean;
  lastLogin: string | null;
};

export async function listAccounts(user: SessionUser): Promise<AccountListItem[] | null> {
  if (!user.isSuperuser) return null;
  return db
    .select({
      id: authUser.id,
      username: authUser.username,
      isSuperuser: authUser.isSuperuser,
      isActive: authUser.isActive,
      lastLogin: authUser.lastLogin,
    })
    .from(authUser)
    .orderBy(authUser.id);
}

// Без похожих символов (0/O, 1/l/I) — пароль диктуют голосом или переписывают с бумажки.
const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TEMP_LENGTH = 12;

function generateTempPassword(): string {
  let out = '';
  for (let i = 0; i < TEMP_LENGTH; i += 1) {
    out += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)];
  }
  return out;
}

/**
 * Сбрасывает пароль аккаунта на временный; возвращает plaintext ОДИН раз
 * (владелец передаёт его человеку разово). null — нет прав или нет аккаунта.
 */
export async function resetAccountPassword(
  user: SessionUser,
  targetId: number,
): Promise<{ username: string; tempPassword: string } | null> {
  if (!user.isSuperuser) return null;
  const [target] = await db
    .select({ id: authUser.id, username: authUser.username })
    .from(authUser)
    .where(eq(authUser.id, targetId))
    .limit(1);
  if (!target) return null;

  const tempPassword = generateTempPassword();
  await db
    .update(authUser)
    .set({ password: hashDjangoPassword(tempPassword) })
    .where(eq(authUser.id, targetId));
  // Две записи: кому сброшен и кто сбросил (у auth_audit нет колонки detail).
  await logAuthAudit(target.id, target.username, 'password_reset', null);
  await logAuthAudit(user.id, user.username, 'password_reset_by', null);
  return { username: target.username, tempPassword };
}

/** Меняет собственный пароль (нужен действующий текущий). false — текущий неверен. */
export async function changeOwnPassword(
  user: SessionUser,
  currentPassword: string,
  nextPassword: string,
): Promise<boolean> {
  const [row] = await db
    .select({ password: authUser.password })
    .from(authUser)
    .where(eq(authUser.id, user.id))
    .limit(1);
  if (!row || !verifyDjangoPassword(currentPassword, row.password)) return false;
  await db
    .update(authUser)
    .set({ password: hashDjangoPassword(nextPassword) })
    .where(eq(authUser.id, user.id));
  await logAuthAudit(user.id, user.username, 'password_changed', null);
  return true;
}
