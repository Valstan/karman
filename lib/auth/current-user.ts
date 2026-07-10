import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { authUser } from '@/lib/db/schema';
import { readSessionUid, readSessionPayload } from './session';
import { totpEnabled } from '@/lib/services/twofactor';
import type { SessionUser } from './rbac';

/**
 * Авторитетная проверка сессии: читает uid из cookie и подтягивает
 * пользователя из БД (ловит деактивированных). Обёрнуто в React cache(),
 * поэтому в рамках одного запроса БД опрашивается один раз.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const uid = await readSessionUid();
  if (uid === null) {
    return null;
  }

  const rows = await db
    .select({
      id: authUser.id,
      username: authUser.username,
      email: authUser.email,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      isSuperuser: authUser.isSuperuser,
      isActive: authUser.isActive,
    })
    .from(authUser)
    .where(eq(authUser.id, uid))
    .limit(1);

  const user = rows[0];
  if (!user || !user.isActive) {
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    isSuperuser: user.isSuperuser,
  };
});

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }
  return user;
}

/**
 * Гейт раздела /secrets (vault Ф2): если у пользователя включён 2FA, сессия
 * обязана пройти второй фактор (claim mfa в JWT). Старые сессии, выданные до
 * включения 2FA, отправляются на повторный вход.
 */
export async function requireSecretsUser(): Promise<SessionUser> {
  const user = await requireUser();
  if (await totpEnabled(user.id)) {
    const payload = await readSessionPayload();
    if (!payload?.mfa) redirect('/login');
  }
  return user;
}
