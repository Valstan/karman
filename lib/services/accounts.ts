import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { accountsAccount, accountsProject, accountsUsage } from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import { decryptSecret, encryptSecret } from '@/lib/secrets/crypto';
import {
  aggregateUsage,
  moscowToday,
  sortAccounts,
  type AccountRotationRow,
  type ProjectUsage,
} from '@/lib/accounts/rotation';
import type {
  AccountActivateInput,
  AccountCreateInput,
  AccountUpdateInput,
  ProjectCreateInput,
} from '@/lib/validation/account';

/**
 * Мультиаккаунт: список аккаунтов, «тушение» до конца суток и учёт проектов.
 *
 * Правило владельца (2026-11-03): аккаунт, который сегодня использован, гаснет
 * до завтра — в списке он уходит вниз, наверх всплывает следующий свободный.
 * Грань суток — московская дата; ночной задачи нет: доступность считается при
 * чтении, поэтому после полуночи аккаунт снова свободен.
 *
 * Пароль — шифротекст AES-256-GCM с AAD от id аккаунта (нельзя переставить
 * шифротекст между строками). Ключ — тот же мастер-ключ, что у vault.
 */

/** AAD пароля: привязывает шифротекст к конкретному аккаунту. */
export function accountPasswordAad(accountId: number): string {
  return `accounts:account:${accountId}:password`;
}

export type AccountListItem = AccountRotationRow & {
  /** Израсходован сегодня (московская дата) — в UI такая строка гаснет. */
  spentToday: boolean;
};

export type ProjectListItem = {
  id: number;
  name: string;
  createdAt: string;
};

/** Все аккаунты пользователя в порядке «доступные сверху, израсходованные снизу». */
export async function listAccounts(user: SessionUser, today: string = moscowToday()): Promise<AccountListItem[]> {
  const rows = await db
    .select({
      id: accountsAccount.id,
      title: accountsAccount.title,
      email: accountsAccount.email,
      usedOn: accountsAccount.usedOn,
      usedAt: accountsAccount.usedAt,
      projectId: accountsAccount.usedProjectId,
      projectName: accountsProject.name,
      lastTokens: accountsAccount.lastTokens,
    })
    .from(accountsAccount)
    .leftJoin(accountsProject, eq(accountsAccount.usedProjectId, accountsProject.id))
    .where(ownership(user, accountsAccount.userId));
  return sortAccounts(rows, today).map((row) => ({ ...row, spentToday: row.usedOn === today }));
}

/**
 * Создаёт аккаунт. Пароль шифруется с AAD от id, поэтому insert и шифрование
 * идут в одной транзакции (insert плейсхолдера → update) — как у карточек
 * секретов.
 */
export async function createAccount(user: SessionUser, input: AccountCreateInput): Promise<number> {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(accountsAccount)
      .values({
        userId: user.id,
        title: input.title,
        email: input.email,
        passwordCt: '',
        passwordIv: '',
        passwordTag: '',
      })
      .returning({ id: accountsAccount.id });
    const id = created!.id;
    const enc = encryptSecret(input.password, accountPasswordAad(id));
    await tx
      .update(accountsAccount)
      .set({ passwordCt: enc.ciphertext, passwordIv: enc.iv, passwordTag: enc.authTag })
      .where(eq(accountsAccount.id, id));
    return id;
  });
}

/** Аккаунт пользователя (id + строка) или null, если чужой/нет. */
async function ownedAccount(
  user: SessionUser,
  accountId: number,
): Promise<{ id: number; email: string } | null> {
  const [row] = await db
    .select({ id: accountsAccount.id, email: accountsAccount.email })
    .from(accountsAccount)
    .where(and(eq(accountsAccount.id, accountId), ownership(user, accountsAccount.userId)))
    .limit(1);
  return row ?? null;
}

export async function updateAccount(user: SessionUser, input: AccountUpdateInput): Promise<boolean> {
  if ((await ownedAccount(user, input.id)) === null) return false;
  const patch: Partial<typeof accountsAccount.$inferInsert> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.email !== undefined) patch.email = input.email;
  if (input.password !== undefined) {
    const enc = encryptSecret(input.password, accountPasswordAad(input.id));
    patch.passwordCt = enc.ciphertext;
    patch.passwordIv = enc.iv;
    patch.passwordTag = enc.authTag;
  }
  if (Object.keys(patch).length === 0) return true;
  await db.update(accountsAccount).set(patch).where(eq(accountsAccount.id, input.id));
  return true;
}

export async function deleteAccount(user: SessionUser, accountId: number): Promise<boolean> {
  if ((await ownedAccount(user, accountId)) === null) return false;
  await db.delete(accountsAccount).where(eq(accountsAccount.id, accountId));
  return true;
}

/**
 * Активация аккаунта: он «гаснет» до завтра, запоминается проект и расход
 * токенов.
 *
 * Идемпотентна по суткам: копирование почты и копирование пароля — одна и та же
 * активация (иначе статистика по проектам удваивалась бы). Повтор в тот же
 * день обновляет время и токены, но не создаёт вторую строку журнала.
 *
 * Токены `undefined` — «не меняю» (кнопка «копировать пароль» не должна
 * затирать уже введённое).
 */
export async function activateAccount(
  user: SessionUser,
  input: AccountActivateInput,
  today: string = moscowToday(),
): Promise<boolean> {
  if ((await ownedAccount(user, input.id)) === null) return false;

  // Проект должен принадлежать владельцу — иначе в журнал попадёт чужой id.
  let projectId: number | null = null;
  if (input.projectId !== undefined && input.projectId !== null) {
    const [project] = await db
      .select({ id: accountsProject.id })
      .from(accountsProject)
      .where(and(eq(accountsProject.id, input.projectId), ownership(user, accountsProject.userId)))
      .limit(1);
    if (!project) return false;
    projectId = project.id;
  }

  const usedAt = new Date().toISOString();
  const tokens = input.tokens;

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: accountsUsage.id, tokens: accountsUsage.tokens })
      .from(accountsUsage)
      .where(
        and(
          eq(accountsUsage.accountId, input.id),
          eq(accountsUsage.usedOn, today),
          ownership(user, accountsUsage.userId),
        ),
      )
      .limit(1);

    const rowTokens = tokens ?? existing?.tokens ?? 0;
    // projectId: undefined — «проект не меняем»; null — «проекта нет»;
    // число — «проект такой». Различать надо: копирование пароля не должно
    // стирать проект, выбранный при копировании почты.
    const projectPatch = input.projectId === undefined ? undefined : projectId;

    await tx
      .update(accountsAccount)
      .set({
        usedOn: today,
        usedAt,
        lastTokens: rowTokens,
        ...(projectPatch !== undefined ? { usedProjectId: projectPatch } : {}),
        updatedAt: usedAt,
      })
      .where(eq(accountsAccount.id, input.id));

    if (existing) {
      await tx
        .update(accountsUsage)
        .set({
          tokens: rowTokens,
          ...(projectPatch !== undefined ? { projectId: projectPatch } : {}),
        })
        .where(eq(accountsUsage.id, existing.id));
    } else {
      await tx.insert(accountsUsage).values({
        userId: user.id,
        accountId: input.id,
        projectId: projectPatch ?? null,
        usedOn: today,
        tokens: rowTokens,
      });
    }
  });
  return true;
}

/** Расшифровывает пароль аккаунта (по клику «копировать пароль»). */
export async function accountPassword(user: SessionUser, accountId: number): Promise<string | null> {
  const [row] = await db
    .select({
      passwordCt: accountsAccount.passwordCt,
      passwordIv: accountsAccount.passwordIv,
      passwordTag: accountsAccount.passwordTag,
    })
    .from(accountsAccount)
    .where(and(eq(accountsAccount.id, accountId), ownership(user, accountsAccount.userId)))
    .limit(1);
  if (!row) return null;
  return decryptSecret(
    { ciphertext: row.passwordCt, iv: row.passwordIv, authTag: row.passwordTag },
    accountPasswordAad(accountId),
  );
}

export async function listProjects(user: SessionUser): Promise<ProjectListItem[]> {
  return db
    .select({ id: accountsProject.id, name: accountsProject.name, createdAt: accountsProject.createdAt })
    .from(accountsProject)
    .where(ownership(user, accountsProject.userId))
    .orderBy(asc(accountsProject.name));
}

export async function createProject(user: SessionUser, input: ProjectCreateInput): Promise<number> {
  const [created] = await db
    .insert(accountsProject)
    .values({ userId: user.id, name: input.name })
    .returning({ id: accountsProject.id });
  return created!.id;
}

export async function deleteProject(user: SessionUser, projectId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: accountsProject.id })
    .from(accountsProject)
    .where(and(eq(accountsProject.id, projectId), ownership(user, accountsProject.userId)))
    .limit(1);
  if (!row) return false;
  await db.delete(accountsProject).where(eq(accountsProject.id, projectId));
  return true;
}

/** Статистика по проектам: сколько активаций и сколько токенов. */
export async function projectUsage(user: SessionUser): Promise<ProjectUsage[]> {
  const rows = await db
    .select({
      projectId: accountsUsage.projectId,
      projectName: accountsProject.name,
      tokens: accountsUsage.tokens,
    })
    .from(accountsUsage)
    .leftJoin(accountsProject, eq(accountsUsage.projectId, accountsProject.id))
    .where(ownership(user, accountsUsage.userId));
  return aggregateUsage(rows);
}

/** Сколько активаций было у каждого проекта за всё время (для списка проектов). */
export async function projectActivationCounts(
  user: SessionUser,
): Promise<Map<number, { activations: number; tokens: number }>> {
  const rows = await db
    .select({
      projectId: accountsUsage.projectId,
      tokens: accountsUsage.tokens,
    })
    .from(accountsUsage)
    .where(ownership(user, accountsUsage.userId));
  const map = new Map<number, { activations: number; tokens: number }>();
  for (const row of rows) {
    if (row.projectId === null) continue;
    const current = map.get(row.projectId) ?? { activations: 0, tokens: 0 };
    current.activations += 1;
    current.tokens += row.tokens;
    map.set(row.projectId, current);
  }
  return map;
}
