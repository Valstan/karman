'use server';

import {
  accountActivateSchema,
  accountCreateSchema,
  accountUpdateSchema,
  projectCreateSchema,
} from '@/lib/validation/account';
import {
  accountPassword,
  accountRating,
  activateAccount,
  createAccount,
  createProject,
  dailyUsage,
  deleteAccount,
  deleteProject,
  importAccounts,
  listAccounts,
  listProjects,
  projectUsage,
  projectUsageByDay,
  updateAccount,
} from '@/lib/services/accounts';
import { parseAccountImport } from '@/lib/accounts/import';
import { splitAccounts } from '@/lib/accounts/rotation';
import { isUniqueViolation } from '@/lib/db/pg-error';
import { currentUserOrNull, revalidateAll, requireSecretsAccess, type ActionResult } from './_internal';

/**
 * Мультиаккаунт (задача владельца 2026-11-03).
 *
 * Раздел доступен ТОЛЬКО владельцу: там лежат пароли от внешних сервисов.
 * Показ пароля — по образцу vault: суперпользователь + step-up 2FA
 * (`requireSecretsAccess`), потому что пароль уходит в буфер обмена.
 */

/**
 * СВЕЖИЙ следующий аккаунт для активации (заказ владельца 08.11).
 *
 * Зачем: страница раздела могла устареть (активация на другой машине), и тогда
 * предложенный аккаунт уже погашен. Владелец жмёт на него — и получает
 * «быстрое окно» с аккаунтом, который БЕЗОПАСНО активировать. Поэтому перед
 * открытием окна состояние перечитывается с сервера, а не берётся из того,
 * что нарисовано на экране.
 *
 * Порядок — тот же, что на экране: тот, что дольше всех не активировался
 * (никогда не использованный — самый первый); аккаунты с исчерпанной неделей
 * не предлагаются (`splitAccounts`).
 */
export async function nextAccountAction(): Promise<
  ActionResult<{
    id: number;
    email: string;
    title: string;
    projectId: number | null;
  } | null>
> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  if (!user.isSuperuser) return { ok: false, error: 'Раздел доступен только владельцу' };
  const now = new Date();
  const accounts = await listAccounts(user, now);
  const { next } = splitAccounts(accounts, now);
  if (!next) return { ok: true, data: null };
  return {
    ok: true,
    data: { id: next.id, email: next.email, title: next.title, projectId: next.projectId },
  };
}

export async function listAccountsAction(): Promise<
  ActionResult<{
    accounts: Awaited<ReturnType<typeof listAccounts>>;
    projects: Awaited<ReturnType<typeof listProjects>>;
    usage: Awaited<ReturnType<typeof projectUsage>>;
    usageByDay: Awaited<ReturnType<typeof projectUsageByDay>>;
    daily: Awaited<ReturnType<typeof dailyUsage>>;
    rating: Awaited<ReturnType<typeof accountRating>>;
  }>
> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  if (!user.isSuperuser) return { ok: false, error: 'Раздел доступен только владельцу' };
  const [accounts, projects, usage, usageByDay, daily, rating] = await Promise.all([
    listAccounts(user),
    listProjects(user),
    projectUsage(user),
    projectUsageByDay(user),
    dailyUsage(user),
    accountRating(user),
  ]);
  return { ok: true, data: { accounts, projects, usage, usageByDay, daily, rating } };
}

export async function createAccountAction(values: unknown): Promise<ActionResult<{ id: number }>> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  if (!user.isSuperuser) return { ok: false, error: 'Раздел доступен только владельцу' };
  const parsed = accountCreateSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  try {
    const id = await createAccount(user, parsed.data);
    revalidateAll();
    return { ok: true, data: { id } };
  } catch (e) {
    if (isUniqueViolation(e)) {
      return { ok: false, error: 'Такой аккаунт уже есть' };
    }
    throw e;
  }
}

export async function updateAccountAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  if (!user.isSuperuser) return { ok: false, error: 'Раздел доступен только владельцу' };
  const parsed = accountUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  try {
    const updated = await updateAccount(user, parsed.data);
    if (!updated) return { ok: false, error: 'Аккаунт не найден' };
    revalidateAll();
    return { ok: true };
  } catch (e) {
    if (isUniqueViolation(e)) {
      return { ok: false, error: 'Такой аккаунт уже есть' };
    }
    throw e;
  }
}

export async function deleteAccountAction(id: number): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  if (!user.isSuperuser) return { ok: false, error: 'Раздел доступен только владельцу' };
  const deleted = await deleteAccount(user, id);
  if (!deleted) return { ok: false, error: 'Аккаунт не найден' };
  revalidateAll();
  return { ok: true };
}

/**
 * Активация аккаунта: гасит его до завтра, запоминает проект и расход токенов.
 * Вызывается ТОЛЬКО явной кнопкой «Активировать» (заказ владельца 05.11):
 * копирование почты или пароля аккаунт больше не гасит.
 */
export async function activateAccountAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  if (!user.isSuperuser) return { ok: false, error: 'Раздел доступен только владельцу' };
  const parsed = accountActivateSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  const activated = await activateAccount(user, parsed.data);
  if (!activated) return { ok: false, error: 'Аккаунт не найден' };
  revalidateAll();
  return { ok: true };
}

/**
 * Отдаёт пароль для копирования. Step-up 2FA обязателен (как в vault): пароль
 * внешнего сервиса уходит в буфер обмена.
 */
export async function revealAccountPasswordAction(id: number): Promise<ActionResult<{ password: string }>> {
  const { user, error } = await requireSecretsAccess();
  if (!user) return { ok: false, error: error ?? 'Нет доступа' };
  const password = await accountPassword(user, id);
  if (password === null) return { ok: false, error: 'Аккаунт не найден' };
  return { ok: true, data: { password } };
}

/**
 * Массовый импорт аккаунтов: список строк «почта|пароль|название».
 *
 * Пароли приходят из браузера владельца и шифруются на сервере мастер-ключом;
 * в репозиторий они не попадают НИКОГДА (репозиторий публичный — там им не
 * место). Повторный импорт того же списка безопасен: уже существующие почты
 * пропускаются и перечисляются в ответе.
 */
export async function importAccountsAction(
  text: string,
): Promise<
  ActionResult<{ created: number; skipped: string[]; failed: string[]; errors: string[] }>
> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  if (!user.isSuperuser) return { ok: false, error: 'Раздел доступен только владельцу' };
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, error: 'Список пуст' };
  }
  const { items, errors } = parseAccountImport(text);
  if (items.length === 0) {
    return { ok: false, error: errors[0] ?? 'Не разобрано ни одной строки' };
  }
  const result = await importAccounts(user, items);
  revalidateAll();
  return { ok: true, data: { ...result, errors } };
}

export async function createProjectAction(values: unknown): Promise<ActionResult<{ id: number }>> {  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  if (!user.isSuperuser) return { ok: false, error: 'Раздел доступен только владельцу' };
  const parsed = projectCreateSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  try {
    const id = await createProject(user, parsed.data);
    revalidateAll();
    return { ok: true, data: { id } };
  } catch (e) {
    if (isUniqueViolation(e)) {
      return { ok: false, error: 'Такой проект уже есть' };
    }
    throw e;
  }
}

export async function deleteProjectAction(id: number): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  if (!user.isSuperuser) return { ok: false, error: 'Раздел доступен только владельцу' };
  const deleted = await deleteProject(user, id);
  if (!deleted) return { ok: false, error: 'Проект не найден' };
  revalidateAll();
  return { ok: true };
}
