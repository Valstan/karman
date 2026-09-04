import 'server-only';
import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
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
 * Гейт раздела /secrets (vault Ф2).
 *
 * Два условия, и порядок между ними важен.
 *
 * 1. **Только суперпользователь** (решение владельца 2026-09-04). В комнатах
 *    лежат ключи ЧУЖИХ проектов экосистемы, а не личные данные вошедшего:
 *    доступ сюда — administrative action, как заведение учёток, а не чтение
 *    своего. Прежний гейт требовал лишь входа, и любой пользователь (на проде
 *    это `Chaka`, id 29) открывал раздел и заводил собственный vault внутри
 *    хранилища экосистемы.
 * 2. Если у пользователя включён 2FA, сессия обязана пройти второй фактор
 *    (claim `mfa` в JWT); старые сессии до включения 2FA идут на повторный вход.
 *
 * Проверка прав стоит ПЕРВОЙ намеренно: `totpEnabled` — запрос в БД, и делать
 * его для того, кого всё равно не пустим, незачем. Сильнее того, у обычного
 * пользователя 2FA обычно выключен, поэтому вторая проверка для него
 * вырождалась в «просто вошёл» — гейт выглядел строгим, не будучи им.
 *
 * Отказ — `notFound()`, а не `redirect('/login')`: вошедшему предлагать
 * повторный вход бессмысленно (войдёт тем же и упрётся снова), а 404 вдобавок
 * не подтверждает, что раздел вообще существует.
 */
export async function requireSecretsUser(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.isSuperuser) notFound();
  if (await totpEnabled(user.id)) {
    const payload = await readSessionPayload();
    if (!payload?.mfa) redirect('/login');
  }
  return user;
}
