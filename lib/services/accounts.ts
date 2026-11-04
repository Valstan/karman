import 'server-only';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { accountsAccount, accountsProject, accountsUsage } from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import { decryptSecret, encryptSecret } from '@/lib/secrets/crypto';
import { isUniqueViolation } from '@/lib/db/pg-error';
import { defaultAccountTitle } from '@/lib/accounts/import';
import {
  ACTIVATION_WINDOW_MS,
  aggregateUsage,
  availableAt,
  isSpent,
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
 * Мультиаккаунт: список аккаунтов, «тушение» на 24 часа и учёт проектов.
 *
 * Правило владельца (04.11): активация гасит аккаунт на СВОИ 24 часа — от
 * момента активации, а не до полуночи по календарю. Каждый аккаунт отсчитывает
 * своё время, поэтому список «оживает» по мере истечения окон. Ночной задачи
 * нет: доступность считается при чтении.
 *
 * Пароль — шифротекст AES-256-GCM с AAD от id аккаунта (нельзя переставить
 * шифротекст между строками). Ключ — тот же мастер-ключ, что у vault.
 */

/** AAD пароля: привязывает шифротекст к конкретному аккаунту. */
export function accountPasswordAad(accountId: number): string {
  return `accounts:account:${accountId}:password`;
}

export type AccountListItem = AccountRotationRow & {
  /** Израсходован ли аккаунт (окно 24 ч с момента активации не истекло) — строка гаснет. */
  spent: boolean;
  /** Когда аккаунт снова свободен (ISO) или null — если не активировался ни разу. */
  availableAt: string | null;
  /** Сколько осталось до освобождения (мс) — для обратного отсчёта в UI. */
  remainingMs: number;
};

export type ProjectListItem = {
  id: number;
  name: string;
  createdAt: string;
};

/** Колонки аккаунта для списка: общие для всего списка и для одного аккаунта. */
const accountColumns = {
  id: accountsAccount.id,
  title: accountsAccount.title,
  email: accountsAccount.email,
  usedOn: accountsAccount.usedOn,
  usedAt: accountsAccount.usedAt,
  projectId: accountsAccount.usedProjectId,
  projectName: accountsProject.name,
  lastTokens: accountsAccount.lastTokens,
};

/** Строка списка: аккаунт + состояние окна простоя. */
function toListItem(row: AccountRotationRow, now: Date): AccountListItem {
  const free = availableAt(row.usedAt);
  return {
    ...row,
    spent: isSpent(row, now),
    availableAt: free,
    remainingMs: free ? Math.max(0, new Date(free).getTime() - now.getTime()) : 0,
  };
}

/** Все аккаунты пользователя в порядке «доступные сверху, израсходованные снизу». */
export async function listAccounts(user: SessionUser, now: Date = new Date()): Promise<AccountListItem[]> {
  const rows = await db
    .select(accountColumns)
    .from(accountsAccount)
    .leftJoin(accountsProject, eq(accountsAccount.usedProjectId, accountsProject.id))
    .where(ownership(user, accountsAccount.userId));
  return sortAccounts(rows, now).map((row) => toListItem(row, now));
}

/**
 * Один аккаунт по id — та же строка списка, что и в разделе (для всплывающего
 * окна). Чужой аккаунт или несуществующий — null.
 */
export async function listAccount(
  user: SessionUser,
  accountId: number,
  now: Date = new Date(),
): Promise<AccountListItem | null> {
  const [row] = await db
    .select(accountColumns)
    .from(accountsAccount)
    .leftJoin(accountsProject, eq(accountsAccount.usedProjectId, accountsProject.id))
    .where(and(eq(accountsAccount.id, accountId), ownership(user, accountsAccount.userId)))
    .limit(1);
  return row ? toListItem(row, now) : null;
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
  // Проект аккаунта можно переключить (04.11: «может быть, изменить проект»).
  // Он должен принадлежать владельцу — иначе аккаунт уедет на чужой id.
  if (input.projectId !== undefined) {
    if (input.projectId === null) {
      patch.usedProjectId = null;
    } else {
      const [project] = await db
        .select({ id: accountsProject.id })
        .from(accountsProject)
        .where(and(eq(accountsProject.id, input.projectId), ownership(user, accountsProject.userId)))
        .limit(1);
      if (!project) return false;
      patch.usedProjectId = project.id;
    }
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
 * Активация аккаунта: копирование почты или пароля = активация. Аккаунт после
 * этого гаснет на СВОИ 24 ЧАСА — от момента активации (правило владельца
 * 04.11); до истечения окна его не активируют заново.
 *
 * Сессия активации: окно открывает ПЕРВОЕ копирование, и оно же держит его
 * открытым. Копирование пароля после копирования почты — продолжение той же
 * сессии: окно не сдвигается, в журнале одна строка (иначе статистика по
 * проектам удваивалась бы). Новая сессия начинается, когда окно истекло.
 *
 * Токены `undefined` — «не меняю» (кнопка «копировать пароль» не должна
 * затирать уже введённое).
 */
export async function activateAccount(
  user: SessionUser,
  input: AccountActivateInput,
  now: Date = new Date(),
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

  const usedAt = now.toISOString();
  const tokens = input.tokens;

  await db.transaction(async (tx) => {
    const [account] = await tx
      .select({
        id: accountsAccount.id,
        usedOn: accountsAccount.usedOn,
        usedAt: accountsAccount.usedAt,
      })
      .from(accountsAccount)
      .where(and(eq(accountsAccount.id, input.id), ownership(user, accountsAccount.userId)))
      .limit(1);
    if (!account) return;

    // Окно ещё открыто → продолжение той же сессии: окно не сдвигается, строка
    // журнала та же. Окно истекло (или активации не было) → новая сессия.
    const sessionOpen =
      account.usedAt !== null &&
      new Date(account.usedAt).getTime() + ACTIVATION_WINDOW_MS > now.getTime();
    const sessionUsedOn = sessionOpen ? account.usedOn! : moscowToday(now);
    const sessionUsedAt = sessionOpen ? account.usedAt! : usedAt;

    const [existing] = await tx
      .select({ id: accountsUsage.id, tokens: accountsUsage.tokens })
      .from(accountsUsage)
      .where(
        and(
          eq(accountsUsage.accountId, input.id),
          eq(accountsUsage.usedOn, sessionUsedOn),
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
        usedOn: sessionUsedOn,
        usedAt: sessionUsedAt,
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
        usedOn: sessionUsedOn,
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

/**
 * Статистика по дням и проектам: «на какой проект в какой день сколько
 * аккаунтов было активировано» (владелец, 03.11).
 *
 * Считается по журналу активаций, а не по текущему состоянию аккаунтов: у
 * аккаунта хранится только ПОСЛЕДНЯЯ активация, а по дням нужно всё.
 */
export type ProjectUsageDay = {
  projectId: number | null;
  projectName: string | null;
  /** Москва-дата активации ('YYYY-MM-DD'). */
  usedOn: string;
  activations: number;
  tokens: number;
};

export async function projectUsageByDay(user: SessionUser): Promise<ProjectUsageDay[]> {
  const rows = await db
    .select({
      projectId: accountsUsage.projectId,
      projectName: accountsProject.name,
      usedOn: accountsUsage.usedOn,
      activations: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum(${accountsUsage.tokens}), 0)::int`,
    })
    .from(accountsUsage)
    .leftJoin(accountsProject, eq(accountsUsage.projectId, accountsProject.id))
    .where(ownership(user, accountsUsage.userId))
    .groupBy(accountsUsage.projectId, accountsProject.name, accountsUsage.usedOn)
    .orderBy(desc(accountsUsage.usedOn), desc(sql<number>`count(*)`));
  return rows;
}

/**
 * Массовый импорт аккаунтов: создаёт отсутствующие, существующие пропускает
 * (идемпотентно — повторный импорт того же списка ничего не ломает).
 *
 * Название по умолчанию — имя ящика (часть до «@»): владелец просил названия
 * аккаунтов брать из названий ящиков.
 */
export type AccountImportResult = {
  created: number;
  /** Почты, которые уже были в базе (дубли). */
  skipped: string[];
  /** Почты, которые не удалось создать (с причиной). */
  failed: string[];
};

export async function importAccounts(
  user: SessionUser,
  items: { title?: string; email: string; password: string }[],
): Promise<AccountImportResult> {
  const result: AccountImportResult = { created: 0, skipped: [], failed: [] };

  for (const item of items) {
    const email = item.email.trim().toLowerCase();
    const [existing] = await db
      .select({ id: accountsAccount.id })
      .from(accountsAccount)
      .where(and(eq(accountsAccount.userId, user.id), eq(accountsAccount.email, email)))
      .limit(1);
    if (existing) {
      result.skipped.push(email);
      continue;
    }
    try {
      await createAccount(user, {
        title: item.title?.trim() || defaultAccountTitle(email),
        email,
        password: item.password,
      });
      result.created += 1;
    } catch (e) {
      if (isUniqueViolation(e)) {
        result.skipped.push(email);
      } else {
        result.failed.push(`${email}: ${e instanceof Error ? e.message : 'неизвестная ошибка'}`);
      }
    }
  }

  return result;
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
