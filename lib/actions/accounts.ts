'use server';

import {
  accountActivateSchema,
  accountActivationIndexSchema,
  accountCreateSchema,
  accountUpdateSchema,
  projectCreateSchema,
} from '@/lib/validation/account';
import {
  accountPassword,
  activateAccount,
  correctActivationIndex,
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
import { pickPoolAccount } from '@/lib/accounts/pool';
import { moscowToday } from '@/lib/accounts/rotation';
import { ensureLiveAccessToken, tokenBackedAccountIds } from '@/lib/services/account-tokens';
import { claimForIssue, markBonusHanded } from '@/lib/services/minimax-daily-bonus';
import { OWNER_TIMEZONE } from '@/lib/minimax/panel';
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
    points: number | null;
  } | null>
> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  if (!user.isSuperuser) return { ok: false, error: 'Раздел доступен только владельцу' };
  const now = new Date();
  const today = moscowToday(now);
  const accounts = await listAccounts(user, now);
  const tokenBacked = await tokenBackedAccountIds();
  // Одна карусель (заказ владельца 20.11): класс очков больше не выбираем — ни
  // для владельца, ни для потребителей. Порядок — тот же, что у потребителей.
  const excluded = new Set<number>();
  const pick = () =>
    pickPoolAccount(accounts, now, {
      excludeIds: [...excluded],
      tokenReadyIds: tokenBacked,
    });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const account = pick().account;
    if (!account) return { ok: true, data: null };
    // Без живой цепочки токенов отдавать нечего (вход в MiniMax делает владелец).
    const token = await ensureLiveAccessToken(account.id, now);
    if (!token) {
      excluded.add(account.id);
      continue;
    }
    // Забор бонуса В МОМЕНТ ВЫДАЧИ — как у потребителей: владелец получает
    // аккаунт, у которого очки действительно есть. Чужая клетка или уже
    // отданная — берём следующего.
    const claim = await claimForIssue({
      userId: user.id,
      accountId: account.id,
      access: token.access_token,
      timezoneId: OWNER_TIMEZONE,
      date: today,
      now,
    });
    if (!claim.ok || !claim.claim.ours || claim.claim.handed) {
      excluded.add(account.id);
      continue;
    }
    // Активацию записываем СРАЗУ (заказ владельца 18.11: страница «Минимакса» теперь
    // без списка аккаунтов, и ручная выдача обязана попадать в журнал — иначе
    // статистика и сторож её не видят).
    const activated = await activateAccount(
      user,
      {
        id: account.id,
        projectId: null,
        source: 'owner',
        ...(claim.claim.dayNo > 0 ? { activationIndex: claim.claim.dayNo } : {}),
      },
      now,
      { onlyIfFree: true },
    );
    if (!activated) {
      excluded.add(account.id);
      continue;
    }
    // Леджер бонусов: кому отдали аккаунт и сколько очков он нёс.
    await markBonusHanded(
      account.id,
      today,
      null,
      claim.claim.points,
      now,
      claim.claim.claimId,
    );
    return {
      ok: true,
      data: {
        id: account.id,
        email: account.email,
        title: account.title,
        projectId: account.projectId,
        points: claim.claim.points,
      },
    };
  }
  return { ok: true, data: null };
}

export async function listAccountsAction(): Promise<
  ActionResult<{
    accounts: Awaited<ReturnType<typeof listAccounts>>;
    projects: Awaited<ReturnType<typeof listProjects>>;
    usage: Awaited<ReturnType<typeof projectUsage>>;
    usageByDay: Awaited<ReturnType<typeof projectUsageByDay>>;
    daily: Awaited<ReturnType<typeof dailyUsage>>;
  }>
> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  if (!user.isSuperuser) return { ok: false, error: 'Раздел доступен только владельцу' };
  const [accounts, projects, usage, usageByDay, daily] = await Promise.all([
    listAccounts(user),
    listProjects(user),
    projectUsage(user),
    projectUsageByDay(user),
    dailyUsage(user),
  ]);
  return { ok: true, data: { accounts, projects, usage, usageByDay, daily } };
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
 * Правка номера активации уже записанного дня (заказ владельца 08.11).
 *
 * «Мало ли, если я забыл, неправильно ее поставил, или забыл вообще ее
 * поменять» — владелец возвращается в окно и называет настоящий номер клетки
 * на панели MiniMax. Очки пересчитываются по номеру (4-я и 7-я — 1000).
 */
export async function correctActivationIndexAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  if (!user.isSuperuser) return { ok: false, error: 'Раздел доступен только владельцу' };
  const parsed = accountActivationIndexSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  const corrected = await correctActivationIndex(
    user,
    parsed.data.id,
    parsed.data.activationIndex,
  );
  if (!corrected) return { ok: false, error: 'Аккаунт не найден или нечего править' };
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

export async function createProjectAction(values: unknown): Promise<ActionResult<{ id: number }>> {
  const user = await currentUserOrNull();
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
