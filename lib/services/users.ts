import 'server-only';
import { randomInt } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
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

export type AccountCreateInput = {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
};

export type AccountCreateResult =
  | { ok: true; id: number; username: string; tempPassword: string }
  | { ok: false; error: string };

/**
 * Заводит аккаунт по приглашению владельца и возвращает временный пароль ОДИН
 * раз — показать в интерфейсе и продиктовать человеку. Единственный путь
 * появления новых людей в системе: самостоятельной регистрации нет, а ЕСА с
 * 2026-09-03 только ВПУСКАЕТ уже заведённых (`lib/services/oidc-login.ts`).
 *
 * Права приглашённого — пустые: `is_superuser` и `is_staff` false. Прав здесь
 * не выдаётся вообще, даже опционально: суперпользователь заводит и блокирует
 * аккаунты, и второй такой же отменил бы это ограничение изнутри.
 */
export async function createAccount(
  user: SessionUser,
  input: AccountCreateInput,
): Promise<AccountCreateResult> {
  if (!user.isSuperuser) return { ok: false, error: 'Приглашать может только владелец' };

  // Регистронезависимо: вход ищет пользователя через lower(username), поэтому
  // «Ulyana» рядом с «ulyana» — это два аккаунта, в которые нельзя войти
  // предсказуемо, а не два разных человека.
  const [takenName] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(sql`lower(${authUser.username}) = lower(${input.username})`)
    .limit(1);
  if (takenName) return { ok: false, error: `Логин «${input.username}» уже занят` };

  // Почта тоже уникальна не по схеме, а по смыслу: на неё завязана привязка
  // личности ЕСА, и при двух совпадениях резолвер отказывается угадывать
  // (`ambiguous_email`) — то есть дубль ломает вход обоим.
  if (input.email !== '') {
    const [takenEmail] = await db
      .select({ id: authUser.id })
      .from(authUser)
      .where(sql`lower(${authUser.email}) = lower(${input.email})`)
      .limit(1);
    if (takenEmail) return { ok: false, error: `Почта «${input.email}» уже занята` };
  }

  const tempPassword = generateTempPassword();
  const [created] = await db
    .insert(authUser)
    .values({
      username: input.username,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      password: hashDjangoPassword(tempPassword),
      isActive: true,
      isSuperuser: false,
      isStaff: false,
    })
    .returning({ id: authUser.id, username: authUser.username });
  if (!created) return { ok: false, error: 'Не удалось создать аккаунт' };

  // Две записи, как у сброса пароля: у auth_audit нет колонки detail, и «кого
  // завели» с «кто завёл» иначе не разделить.
  await logAuthAudit(created.id, created.username, 'account_created', null);
  await logAuthAudit(user.id, user.username, 'account_created_by', null);
  return { ok: true, id: created.id, username: created.username, tempPassword };
}

/**
 * Включает/отключает аккаунт. Отключение гасит ВСЕ пути входа сразу: пароль
 * (`/api/auth/login`), ЕСА (`resolveOidcLogin` → `user_inactive`) и уже выданную
 * сессию — `getCurrentUser` перечитывает `is_active` из БД на каждом запросе.
 *
 * Себя отключить нельзя: это единственная операция, после которой владелец
 * теряет доступ к экрану, на котором её же и отменяют.
 */
export async function setAccountActive(
  user: SessionUser,
  targetId: number,
  isActive: boolean,
): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
  if (!user.isSuperuser) return { ok: false, error: 'Нет прав' };
  if (targetId === user.id) return { ok: false, error: 'Нельзя отключить собственный аккаунт' };
  const [target] = await db
    .select({ id: authUser.id, username: authUser.username })
    .from(authUser)
    .where(eq(authUser.id, targetId))
    .limit(1);
  if (!target) return { ok: false, error: 'Аккаунт не найден' };

  await db.update(authUser).set({ isActive }).where(eq(authUser.id, targetId));
  await logAuthAudit(target.id, target.username, isActive ? 'account_enabled' : 'account_disabled', null);
  await logAuthAudit(user.id, user.username, 'account_state_changed_by', null);
  return { ok: true, username: target.username };
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
