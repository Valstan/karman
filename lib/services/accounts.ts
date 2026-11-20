import 'server-only';
import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  accountsAccount,
  accountsDailyBonus,
  accountsProject,
  accountsUsage,
} from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import { decryptSecret, encryptSecret } from '@/lib/secrets/crypto';
import { isUniqueViolation } from '@/lib/db/pg-error';
import { defaultAccountTitle } from '@/lib/accounts/import';
import {
  aggregateDailyUsage,
  type DailyUsage,
} from '@/lib/accounts/stats';
import {
  aggregateUsage,
  availableAt,
  dailyResetAfter,
  freeBefore,
  isSpent,
  moscowToday,
  sortAccounts,
  type AccountRotationRow,
  type ProjectUsage,
} from '@/lib/accounts/rotation';
import {
  isFreshPanelState,
  markPanelStatesClaimed,
  readPanelStates,
  type PanelState,
} from '@/lib/accounts/panel-state';
import { OWNER_TIMEZONE, panelClaimable } from '@/lib/minimax/panel';
import { CLAIM_RESULT_CLAIMED } from '@/lib/minimax/claim';
import {
  WEEKLY_ACTIVATION_LIMIT,
  pointsForIndex,
  weeklyQuota,
  type WeeklyCheckIn,
  type WeeklyQuota,
} from '@/lib/accounts/weekly';
import type {
  AccountActivateInput,
  AccountCreateInput,
  AccountUpdateInput,
  ProjectCreateInput,
} from '@/lib/validation/account';

/**
 * Мультиаккаунт: список аккаунтов, «тушение» на 10 часов и учёт проектов.
 *
 * Правило владельца (04.11, уточнено 07.11 и 08.11): активация гасит аккаунт
 * на СВОИ 10 ЧАСОВ — от момента активации, а не до полуночи по календарю. Каждый
 * аккаунт отсчитывает своё время, поэтому список «оживает» по мере истечения
 * окон. Ночной задачи нет: доступность считается при чтении.
 *
 * Неделя (заказ владельца 07.11): недельная квота аккаунта — 7 активаций, и
 * неделя у каждого своя (7 дней от первого использования, как устроено окно
 * MiniMax). См. `lib/accounts/weekly.ts`.
 *
 * Пароль — шифротекст AES-256-GCM с AAD от id аккаунта (нельзя переставить
 * шифротекст между строками). Ключ — тот же мастер-ключ, что у vault.
 */

/** AAD пароля: привязывает шифротекст к конкретному аккаунту. */
export function accountPasswordAad(accountId: number): string {
  return `accounts:account:${accountId}:password`;
}

export type AccountListItem = AccountRotationRow & {
  /** Израсходован ли аккаунт (окно простоя не истекло) — строка гаснет. */
  spent: boolean;
  /** Когда аккаунт снова свободен (ISO) или null — если не активировался ни разу. */
  availableAt: string | null;
  /** Сколько осталось до освобождения (мс) — для обратного отсчёта в UI. */
  remainingMs: number;
  /** Сколько сессий активации у аккаунта за всю историю (заказ владельца 05.11). */
  activations: number;
  /** Сколько токенов на них ушло суммарно — по всем активациям, не только за последнюю. */
  totalTokens: number;
  /**
   * Недельная квота аккаунта (заказ владельца 07.11): неделя у аккаунта своя —
   * 7 дней от его ПЕРВОГО использования (окно MiniMax). По ней считается, какой
   * номер у следующей активации и сколько очков за неё положено.
   */
  week: WeeklyQuota;
  /** Номер активации, записанный за сегодняшний чек-ин (если он был). */
  weekTodayIndex: number | null;
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

/**
 * Строка списка: аккаунт + состояние окна простоя + недельная квота.
 */
function toListItem(
  row: AccountRotationRow,
  now: Date,
  stats?: { activations: number; tokens: number },
  week?: WeeklyQuota,
  weekTodayIndex: number | null = null,
): AccountListItem {
  const free = availableAt(row.usedAt);
  return {
    ...row,
    spent: isSpent(row, now),
    availableAt: free,
    remainingMs: free ? Math.max(0, new Date(free).getTime() - now.getTime()) : 0,
    activations: stats?.activations ?? 0,
    totalTokens: stats?.tokens ?? 0,
    week: week ?? weeklyQuota([], moscowToday(now)),
    weekTodayIndex,
  };
}

/**
 * Панель MiniMax в строке аккаунта — только свежий ответ.
 *
 * Протухший ответ панели — это «не знаю», а не «очков нет»: иначе аккаунт,
 * у которого очки давно появились, навсегда остался бы вне оборота (ровно та
 * беда, которую чинит заказ владельца 16.11). Поэтому свежесть решает всё:
 * ответ старше получаса не попадает в строку вовсе.
 */
function panelFields(
  panel: PanelState | undefined,
  now: Date,
): Pick<
  AccountRotationRow,
  'panelStatus' | 'panelPoints' | 'panelCellNo' | 'panelCheckedAt'
> {
  if (!isFreshPanelState(panel, now)) {
    return { panelStatus: null, panelPoints: null, panelCellNo: null, panelCheckedAt: null };
  }
  return {
    panelStatus: panel!.status,
    panelPoints: panel!.points,
    panelCellNo: panel!.cell_no,
    panelCheckedAt: panel!.checked_at,
  };
}

/**
 * Очки следующей активации: правда — по нашему забору, панель — только если мы
 * сегодня ещё не забирали.
 *
 * Панель остатка НЕ показывает (`points` клетки — её номинал, а не «сколько
 * осталось»), поэтому очки определяет то, кто забрал клетку:
 *
 * - забрали мы → очки наши и свежие → номинал клетки из леджера;
 * - забрал потребитель → очки потрачены → ноль;
 * - забора ещё не было → панель: «очки есть» → номинал; «забрано» → ноль;
 * - панели нет → считаем по недельной квоте, как раньше.
 */
function pointsNext(
  row: {
    usedAt: string | null;
    panelStatus?: number | null;
    bonusOurs?: boolean | null;
    bonusPoints?: number | null;
  },
  panel: PanelState | undefined,
  quota: WeeklyQuota | undefined,
  now: Date,
): number {
  if (row.bonusOurs === true) return row.bonusPoints ?? 0;
  if (row.bonusOurs === false) return 0;
  if (panel && isFreshPanelState(panel, now)) {
    if (panelClaimable(panel.status)) return panel.points ?? 0;
    return 0;
  }
  if (isSpent(row, now)) return 0;
  return quota?.pointsToday ?? 0;
}

/**
 * Чек-ины аккаунтов из журнала: московская дата и (если есть) подтверждённый
 * владельцем номер активации.
 *
 * Журнал — единственный источник: у аккаунта хранится только ПОСЛЕДНЯЯ
 * активация, а недельная квота считается по всей его истории.
 */
async function accountCheckIns(user: SessionUser): Promise<Map<number, WeeklyCheckIn[]>> {
  const rows = await db
    .select({
      accountId: accountsUsage.accountId,
      usedOn: accountsUsage.usedOn,
      activationIndex: accountsUsage.activationIndex,
      // Источник и момент активации: по ним видно ручную активацию владельца
      // (заказ владельца 19.11, ночь) — она убирает аккаунт из счётчика.
      source: accountsUsage.source,
      createdAt: accountsUsage.createdAt,
    })
    .from(accountsUsage)
    .where(ownership(user, accountsUsage.userId));
  const byAccount = new Map<number, WeeklyCheckIn[]>();
  for (const row of rows) {
    const list = byAccount.get(row.accountId) ?? [];
    list.push({
      date: row.usedOn,
      index: row.activationIndex,
      source: row.source === 'owner' ? 'owner' : 'api',
      createdAt: row.createdAt,
    });
    byAccount.set(row.accountId, list);
  }
  return byAccount;
}

/**
 * Забрали ли сегодняшнюю клетку МЫ (null — судить не по чему).
 *
 * Единственный верный признак — `claim_result` из ответа вендора на забор:
 * 1 — забрали сейчас (мы), 2 — клетку забрали ДО нас (потребитель; обычно это
 * ночь после пропущенного дня, когда клетка вендора ещё стояла на месте).
 *
 * **Почему не «остаток очков»:** панель остатка НЕ показывает — `points` клетки
 * это её НОМИНАЛ (400 или 1000), а не «сколько осталось» (живая проверка 18.11:
 * у аккаунта с давно потраченными очками панель отвечает `points: 1000,
 * bonus_points: 0`). Поэтому «очки ли» по панели не определить, и не нужно:
 * свежесть очков определяет, кто забрал клетку.
 */
function bonusOurs(claimResult: number | null): boolean | null {
  if (claimResult === null) return null;
  return claimResult === CLAIM_RESULT_CLAIMED;
}

/**
 * Недельная квота по аккаунтам: состояние + был ли сегодня чек-ин + номер,
 * записанный за сегодняшний чек-ин.
 */
function weekStates(
  checkIns: Map<number, WeeklyCheckIn[]>,
  today: string,
): Map<number, { week: WeeklyQuota; checkedInToday: boolean; todayIndex: number | null }> {
  const states = new Map<number, { week: WeeklyQuota; checkedInToday: boolean; todayIndex: number | null }>();
  for (const [accountId, list] of checkIns) {
    const todayCheckIn = list.find((c) => c.date === today);
    states.set(accountId, {
      week: weeklyQuota(list, today),
      checkedInToday: todayCheckIn !== undefined,
      todayIndex: todayCheckIn?.index ?? null,
    });
  }
  return states;
}

/**
 * Сколько сессий активации у аккаунта и сколько на них токенов — по журналу
 * `accounts_usage` (заказ владельца 05.11: «сколько раз он был активирован»).
 *
 * Считается по журналу, а не по текущему состоянию аккаунта: у аккаунта хранится
 * только ПОСЛЕДНЯЯ активация, а рейтинг и строка аккаунта нуждаются во всей
 * истории.
 */
async function accountUsageStats(
  user: SessionUser,
  accountId?: number,
): Promise<Map<number, { activations: number; tokens: number }>> {
  const rows = await db
    .select({
      accountId: accountsUsage.accountId,
      activations: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum(${accountsUsage.tokens}), 0)::int`,
    })
    .from(accountsUsage)
    .where(
      accountId === undefined
        ? ownership(user, accountsUsage.userId)
        : and(ownership(user, accountsUsage.userId), eq(accountsUsage.accountId, accountId)),
    )
    .groupBy(accountsUsage.accountId);
  return new Map(rows.map((row) => [row.accountId, { activations: row.activations, tokens: row.tokens }]));
}

/**
 * Последняя ручная активация владельцем (ISO) или null.
 *
 * Заказ владельца 19.11 (ночь): «если вручную активированы мною, то они тоже из
 * счётчика убираются до следующих суток, которые у нас начинаются в 5 утра по
 * Москве». То есть пока ручная активация позже последнего забора — аккаунт из
 * счётчика убран (его очки — владельца).
 */
function lastOwnerActivation(checkIns: WeeklyCheckIn[]): string | null {
  let latest: string | null = null;
  for (const checkIn of checkIns) {
    if (checkIn.source !== 'owner' || !checkIn.createdAt) continue;
    if (latest === null || checkIn.createdAt > latest) latest = checkIn.createdAt;
  }
  return latest;
}

/**
 * Остаток очков по нашему леджеру бонусов за московские сутки (заказ владельца
 * 18.11): сколько очков лежало на аккаунте при последней нашей проверке.
 *
 * Нужен строке списка, чтобы отличить «очки забрал наш утренний обход — ждут
 * потребителя» от «очки забрал потребитель — по аккаунту работают»: у забранной
 * клетки панель отдаёт остаток, а не номинал, и без леджера эти случаи неразличимы.
 */
async function dailyBonusStates(
  userId: number,
  today: string,
): Promise<
  Map<
    number,
    {
      remaining: number | null;
      points: number | null;
      dayNo: number | null;
      claimResult: number | null;
      handedAt: string | null;
      claimedAt: string | null;
    }
  >
> {
  const rows = await db
    .select({
      accountId: accountsDailyBonus.accountId,
      remaining: accountsDailyBonus.remaining,
      points: accountsDailyBonus.points,
      dayNo: accountsDailyBonus.dayNo,
      claimResult: accountsDailyBonus.claimResult,
      handedAt: accountsDailyBonus.handedAt,
      // Когда забрали (05:00 МСК): сравнением с ручной активацией понимаем, что
      // аккаунт занят до следующего забора.
      claimedAt: accountsDailyBonus.claimedAt,
    })
    .from(accountsDailyBonus)
    .where(and(eq(accountsDailyBonus.userId, userId), eq(accountsDailyBonus.usedOn, today)));
  const out = new Map<
    number,
    {
      remaining: number | null;
      points: number | null;
      dayNo: number | null;
      claimResult: number | null;
      handedAt: string | null;
      claimedAt: string | null;
    }
  >();
  for (const row of rows) {
    out.set(row.accountId, {
      remaining: row.remaining,
      points: row.points,
      dayNo: row.dayNo,
      claimResult: row.claimResult,
      handedAt: row.handedAt,
      claimedAt: row.claimedAt,
    });
  }
  return out;
}

/**
 * Все аккаунты пользователя в порядке «доступные сверху, израсходованные снизу».
 *
 * `timezoneId` — пояс, по которому берётся ответ панели MiniMax: у панели
 * владельца (Europe/Moscow) и у панели проекта (UTC) «сегодня» — разные дни в
 * ночном окне между 00:00 и 03:00 МСК. По умолчанию — пояс владельца.
 */
export async function listAccounts(
  user: SessionUser,
  now: Date = new Date(),
  options: { timezoneId?: string } = {},
): Promise<AccountListItem[]> {
  const today = moscowToday(now);
  const timezoneId = options.timezoneId ?? OWNER_TIMEZONE;
  const [rows, stats, checkIns, panelStates, bonusStates] = await Promise.all([
    db
      .select(accountColumns)
      .from(accountsAccount)
      .leftJoin(accountsProject, eq(accountsAccount.usedProjectId, accountsProject.id))
      .where(ownership(user, accountsAccount.userId)),
    accountUsageStats(user),
    accountCheckIns(user),
    readPanelStates(user.id, timezoneId),
    dailyBonusStates(user.id, today),
  ]);
  const states = weekStates(checkIns, today);
  const enriched = rows.map((row) => {
    const state = states.get(row.id);
    const panel = panelStates.get(row.id);
    const withPanel = { ...row, ...panelFields(panel, now) };
    // Наш забор сегодня: клетка, её номинал и — главное — забрали ли её МЫ.
    const bonus = bonusStates.get(row.id) ?? null;
    const bonusOursValue = bonusOurs(bonus?.claimResult ?? null);
    const bonusPointsValue = bonus?.points ?? null;
    const withBonus = {
      ...withPanel,
      bonusRemaining: bonus?.remaining ?? null,
      bonusPoints: bonusPointsValue,
      bonusDayNo: bonus?.dayNo ?? null,
      bonusOurs: bonusOursValue,
      bonusHandedAt: bonus?.handedAt ?? null,
      bonusClaimedAt: bonus?.claimedAt ?? null,
    };
    return {
      ...withBonus,
      // Последняя ручная активация владельцем: такой аккаунт уходит из счётчика
      // до следующего забора (заказ владельца 19.11, ночь).
      ownerUsedAt: lastOwnerActivation(checkIns.get(row.id) ?? []),
      weekUsed: state?.week.used ?? 0,
      weekExhausted: state?.week.exhausted ?? false,
      // Чек-ин за сегодня уже был → сегодняшнего бонуса у аккаунта нет, и в
      // верхний слот он не попадает (заказ владельца 08.11).
      weekCheckedInToday: state?.checkedInToday ?? false,
      // Очки следующей активации и расстояние до бонусной клетки — по ним
      // выбирается, кого активировать (заказ владельца 11.11).
      // Панель ответила — верим ей (заказ владельца 16.11); иначе считаем по
      // недельной квоте, а сожжённый бонус (ночной сброс после активации ещё
      // не наступил) даёт ноль.
      weekPointsNext: pointsNext(withBonus, panel, state?.week, now),
      weekDaysToBonus: state?.week.daysToBonus ?? WEEKLY_ACTIVATION_LIMIT,
      weekStreak: state?.week.streak ?? 0,
    };
  });
  return sortAccounts(enriched, now).map((row) => {
    const state = states.get(row.id);
    return toListItem(
      row,
      now,
      stats.get(row.id),
      state?.week,
      state?.todayIndex ?? null,
    );
  });
}

/**
 * Один аккаунт по id — та же строка списка, что и в разделе (для всплывающего
 * окна). Чужой аккаунт или несуществующий — null.
 */
export async function listAccount(
  user: SessionUser,
  accountId: number,
  now: Date = new Date(),
  options: { timezoneId?: string } = {},
): Promise<AccountListItem | null> {
  const today = moscowToday(now);
  const timezoneId = options.timezoneId ?? OWNER_TIMEZONE;
  const [row] = await db
    .select(accountColumns)
    .from(accountsAccount)
    .leftJoin(accountsProject, eq(accountsAccount.usedProjectId, accountsProject.id))
    .where(and(eq(accountsAccount.id, accountId), ownership(user, accountsAccount.userId)))
    .limit(1);
  if (!row) return null;
  const [stats, checkIns, panelStates, bonusStates] = await Promise.all([
    accountUsageStats(user, accountId),
    accountCheckIns(user),
    readPanelStates(user.id, timezoneId, [accountId]),
    dailyBonusStates(user.id, today),
  ]);
  const state = weekStates(checkIns, today).get(accountId);
  const panel = panelStates.get(accountId);
  const withPanel = { ...row, ...panelFields(panel, now) };
  const bonus = bonusStates.get(accountId) ?? null;
  const withBonus = {
    ...withPanel,
    bonusRemaining: bonus?.remaining ?? null,
    bonusPoints: bonus?.points ?? null,
    bonusDayNo: bonus?.dayNo ?? null,
    bonusOurs: bonusOurs(bonus?.claimResult ?? null),
    bonusHandedAt: bonus?.handedAt ?? null,
    bonusClaimedAt: bonus?.claimedAt ?? null,
  };
  return toListItem(
    {
      ...withBonus,
      // Последняя ручная активация владельцем (см. listAccounts) — тот же признак.
      ownerUsedAt: lastOwnerActivation(checkIns.get(accountId) ?? []),
      weekUsed: state?.week.used ?? 0,
      weekExhausted: state?.week.exhausted ?? false,
      weekCheckedInToday: state?.checkedInToday ?? false,
      // Панель ответила — верим ей (заказ владельца 16.11); иначе считаем по
      // недельной квоте, а сожжённый бонус даёт ноль.
      weekPointsNext: pointsNext(withBonus, panel, state?.week, now),
      weekDaysToBonus: state?.week.daysToBonus ?? WEEKLY_ACTIVATION_LIMIT,
      weekStreak: state?.week.streak ?? 0,
    },
    now,
    stats.get(accountId),
    state?.week,
    state?.todayIndex ?? null,
  );
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
 * Активация аккаунта: гасит его ДО НОЧНОГО СБРОСА у MiniMax — суточный
 * бонус сожжён, и до сброса аккаунт ни проекту не отдаётся, ни очков не даёт
 * (мандат владельца 15.11; подробности — `lib/accounts/rotation.ts`).
 *
 * Вызывается ТОЛЬКО явной кнопкой «Активировать» (заказ владельца 05.11):
 * копирование почты или пароля аккаунт не гасит и в журнал не пишет.
 *
 * Сессия активации: окно открывает кнопка «Активировать», и она же держит его
 * открытым. Повторная активация того же аккаунта, пока окно не истекло, —
 * продолжение той же сессии: окно не сдвигается, в журнале одна строка (иначе
 * статистика по проектам удваивалась бы). Новая сессия начинается, когда окно
 * истекло.
 *
 * НОМЕР АКТИВАЦИИ В НЕДЕЛЕ (заказ владельца 07.11, уточнение 08.11): очки
 * MiniMax даёт ежедневный чек-ин — 400 очков, а в 4-й и 7-й день недели 1000.
 * Номер считается по недельной квоте аккаунта (неделя своя: 7 дней от первого
 * использования) — это КАЛЕНДАРНАЯ позиция дня в окне, а не число строк
 * журнала (см. `lib/accounts/weekly.ts`).
 *
 * - `tokens` undefined — «не меняю»: у уже записанного дня очки не затираются;
 *   у нового дня берутся по номеру активации;
 * - `activationIndex` undefined — «определи сам» (по недельной квоте);
 * - `activationIndex` задан — очки считаются ПО НЕМУ: 4-я и 7-я дают 1000,
 *   остальные 400. Номер, названный владельцем, — это то, что он увидел на
 *   панели MiniMax, и программа дальше считает от него.
 */
export async function activateAccount(
  user: SessionUser,
  input: AccountActivateInput,
  now: Date = new Date(),
  options?: { onlyIfFree?: boolean },
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
  const today = moscowToday(now);

  const activated = await db.transaction(async (tx) => {
    const [account] = await tx
      .select({
        id: accountsAccount.id,
        usedOn: accountsAccount.usedOn,
        usedAt: accountsAccount.usedAt,
      })
      .from(accountsAccount)
      .where(and(eq(accountsAccount.id, input.id), ownership(user, accountsAccount.userId)))
      .limit(1);
    if (!account) return false;

    // Окно ещё открыто → продолжение той же сессии: окно не сдвигается, строка
    // Сессия ещё открыта → продолжение той же сессии: окно не сдвигается,
    // строка журнала та же. Сессия истекла (или активации не было) → новая.
    const sessionOpen =
      account.usedAt !== null &&
      dailyResetAfter(new Date(account.usedAt)).getTime() > now.getTime();
    // Сожжён ли суточный бонус: пока сессия открыта — сброс не наступил, значит
    // повторная активация очков не даёт (чек-ин в сутки один).
    const burned = sessionOpen;
    const sessionUsedOn = sessionOpen ? account.usedOn! : moscowToday(now);
    const sessionUsedAt = sessionOpen ? account.usedAt! : usedAt;
    const [existing] = await tx
      .select({
        id: accountsUsage.id,
        tokens: accountsUsage.tokens,
        activationIndex: accountsUsage.activationIndex,
        source: accountsUsage.source,
      })
      .from(accountsUsage)
      .where(
        and(
          eq(accountsUsage.accountId, input.id),
          eq(accountsUsage.usedOn, sessionUsedOn),
          ownership(user, accountsUsage.userId),
        ),
      )
      .limit(1);

    // Строка журнала от ПРЕДЫДУЩЕЙ выдачи, которую сторож уже вернул в оборот
    // (сессия снята → `used_at` пуст, а строка журнала осталась: запись выдачи — это
    // запись, её не стираем; мадат владельца 18.11, 21:40 МСК). Это НОВАЯ выдача, а не
    // продолжение прежней: метка и проект переписываются, иначе расход уйдёт не туда.
    const stale = existing !== undefined && account.usedAt === null;

    // Недельная квота аккаунта — по его журналу. Номер активации: явно
    // заданный владельцем (он смотрит панель MiniMax), иначе посчитанный по
    // квоте — календарная позиция дня в неделе аккаунта.
    const checkIns = await tx
      .select({
        usedOn: accountsUsage.usedOn,
        activationIndex: accountsUsage.activationIndex,
      })
      .from(accountsUsage)
      .where(and(eq(accountsUsage.accountId, input.id), ownership(user, accountsUsage.userId)));
    const quota = weeklyQuota(
      checkIns.map((row) => ({ date: row.usedOn, index: row.activationIndex })),
      today,
    );
    const index = input.activationIndex ?? quota.nextIndex ?? null;
    // Отмечен ли аккаунт сегодня (чек-ин в сутки один).
    const checkedInToday = checkIns.some((row) => row.usedOn === today);

    // Очки считаются ПО НОМЕРУ АКТИВАЦИИ: 4-я и 7-я клетки — 1000, остальные
    // 400. Номер, названный владельцем, — истина (заказ 08.11: «очки будут в
    // зависимости от этой точки проставляться»), поэтому при заданном номере
    // очки берутся из него, а не из присланного значения.
    //
    // Чек-ин в сутки один: строка дня уже есть → сегодняшние очки не затираем,
    // а номер дня остаётся прежним (иначе «не меняю» превратилось бы в затирку).
    //
    // **А отмеченный сегодня аккаунт сегодня очков НЕ даёт** (заказ владельца
    // 11.11) — поэтому в модели очки нулевые, а не по клетке. Иначе выдача такого
    // аккаунта проекту (последний резерв пула) записала бы в статистику 400 очков,
    // которых у MiniMax нет.
    const rowTokens =
      input.activationIndex !== undefined && index !== null
        ? pointsForIndex(index)
        : (tokens ??
          (existing && !stale ? existing.tokens : undefined) ??
          (index !== null
            ? (burned || (checkedInToday && !stale) ? 0 : pointsForIndex(index))
            : 0));
    const rowIndex =
      existing && input.activationIndex === undefined ? existing.activationIndex : index;
    // projectId: undefined — «проект не меняем»; null — «проекта нет»;
    // число — «проект такой». Различать надо: копирование пароля не должно
    // стирать проект, выбранный при копировании почты.

    // Метка «кто потратил аккаунт» (миграция 0033) ставится ТОЛЬКО при создании
    // строки: существующая строка сохраняет свою метку. Иначе выдача аккаунта,
    // отмеченного сегодня владельцем, переписала бы его запись (проект и очки) на
    // проектную — и 400 очков владельца исчезли бы из его статистики.
    const newSource = input.source ?? 'owner';
    const source = stale ? newSource : (existing?.source ?? newSource);

    // Проект строки — тоже не переписывается, если строка принадлежит другому
    // источнику: запись по запросу проекта (source = 'api') остаётся своей, и
    // программирование владельца не забирает её себе (и наоборот). Внутри одной
    // транзакции — гонки не бывает: «владелец активировал, тут же выдали» решается
    // тем, кто записал строку первым.
    const sameSource = stale || !existing || existing.source === newSource;
    const projectPatch =
      input.projectId === undefined || !sameSource ? undefined : projectId;

    // Захват аккаунта. При `onlyIfFree` обновление идёт ТОЛЬКО если аккаунт
    // ещё свободен (бонус не сожжён): гонка двух проектов за один аккаунт решена
    // на уровне БД — второй получит 0 обновлённых строк и возьмёт другой.
    const cutoff = freeBefore(now).toISOString();
    const updated = await tx
      .update(accountsAccount)
      .set({
        usedOn: sessionUsedOn,
        usedAt: sessionUsedAt,
        lastTokens: rowTokens,
        ...(projectPatch !== undefined ? { usedProjectId: projectPatch } : {}),
        updatedAt: usedAt,
      })
      .where(
        options?.onlyIfFree
          ? and(
              eq(accountsAccount.id, input.id),
              or(isNull(accountsAccount.usedAt), lt(accountsAccount.usedAt, cutoff)),
            )
          : eq(accountsAccount.id, input.id),
      )
      .returning({ id: accountsAccount.id });
    if (updated.length === 0) return false;

    if (existing) {
      await tx
        .update(accountsUsage)
        .set({
          tokens: rowTokens,
          activationIndex: rowIndex,
          source,
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
        activationIndex: rowIndex,
        source,
      });
    }
    return true;
  });

  // Очки только что сожглись — панель MiniMax об этом ещё не знает (она узнает
  // при следующей сверке). Помечаем её ответ «очки сожжены», а НЕ удаляем:
  // удалённый ответ означал бы возврат к модели по датам, а модель с панелью
  // разошлась (живая сверка 16.11: класс очков расходится у 48 аккаунтов из
  // 109) — в каталоге появлялись «тысячные», которые на деле давали 400.
  // Помеченный ответ правдив сразу, а сверка вернёт «очки есть» после
  // ночного сброса, и аккаунт вернётся в оборот сам.
  if (activated) await markPanelStatesClaimed(input.id, now);
  return activated;
}

/**
 * Правка номера активации уже записанного дня (заказ владельца 08.11).
 *
 * «Мало ли, если я забыл, неправильно ее поставил, или забыл вообще ее
 * поменять» — владелец должен иметь возможность вернуться и указать настоящий
 * номер клетки на панели MiniMax. Очки пересчитываются по новому номеру
 * (4-я и 7-я — 1000, остальные 400), потому что очки — производная от номера.
 *
 * Правка идёт по последней записи журнала этого аккаунта (тот день, за который
 * он и хочет пересчитать) — привязка к «сегодня» была бы неверна: активация
 * могла быть вчера.
 */
export async function correctActivationIndex(
  user: SessionUser,
  accountId: number,
  activationIndex: number,
): Promise<boolean> {
  if ((await ownedAccount(user, accountId)) === null) return false;
  if (!Number.isInteger(activationIndex) || activationIndex < 1 || activationIndex > 7) {
    return false;
  }

  return db.transaction(async (tx) => {
    // Последняя строка журнала аккаунта — тот день, который владелец правит.
    const [row] = await tx
      .select({ id: accountsUsage.id, tokens: accountsUsage.tokens })
      .from(accountsUsage)
      .where(and(eq(accountsUsage.accountId, accountId), ownership(user, accountsUsage.userId)))
      .orderBy(desc(accountsUsage.usedOn), desc(accountsUsage.id))
      .limit(1);
    if (!row) return false;

    const tokens = pointsForIndex(activationIndex);
    await tx
      .update(accountsUsage)
      .set({ tokens, activationIndex })
      .where(eq(accountsUsage.id, row.id));

    // У аккаунта «очки за последнюю активацию» — те же, что в строке журнала:
    // правка номера обязана их обновить, иначе строка аккаунта разойдётся с
    // журналом. Правка идёт по ПОСЛЕДНЕЙ строке журнала — значит, это и есть
    // последняя активация.
    await tx
      .update(accountsAccount)
      .set({ lastTokens: tokens })
      .where(eq(accountsAccount.id, accountId));
    return true;
  });
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
 * Расход аккаунтов ПО ЗАПРОСАМ ПРОЕКТОВ — по дням.
 *
 * Заказ владельца 14.11: «в статистике отдельно учитывай расход аккаунтов минимакса
 * запросами с Сарафана — это не программирование, это сам проект Сарафан тратит
 * аккаунты на обработки постов из ВК. Это надо подсчитывать отдельно от аккаунтов,
 * которые я трачу на программирование, но также по дням смотреть, чтобы в какие дни
 * по сколько аккаунтов и очков тратится на Сарафане».
 *
 * Различаем по МЕТКЕ в строке журнала (`accounts_usage.source = 'api'`), а не по
 * названию проекта: у владельца проект «САРАФАН» (кириллица — программирование), у
 * комнаты «SARAFAN» (латиница) — разница в одном символе, а не различие.
 */
export type ApiUsageDay = {
  /** Москва-дата активации ('YYYY-MM-DD'). */
  usedOn: string;
  /** Сколько аккаунтов ушло по запросам проектов в этот день. */
  activations: number;
  /** Сколько очков на них ушло. */
  tokens: number;
  /** Проекты, чьи запросы привели к этим активациям. */
  projects: {
    projectId: number | null;
    projectName: string | null;
    activations: number;
    tokens: number;
  }[];
};

export async function apiUsageByDay(user: SessionUser): Promise<ApiUsageDay[]> {
  const rows = await db
    .select({
      usedOn: accountsUsage.usedOn,
      projectId: accountsUsage.projectId,
      projectName: accountsProject.name,
      activations: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum(${accountsUsage.tokens}), 0)::int`,
    })
    .from(accountsUsage)
    .leftJoin(accountsProject, eq(accountsUsage.projectId, accountsProject.id))
    .where(and(ownership(user, accountsUsage.userId), eq(accountsUsage.source, 'api')))
    .groupBy(accountsUsage.usedOn, accountsUsage.projectId, accountsProject.name)
    .orderBy(desc(accountsUsage.usedOn));

  // Свернуть по дню: внутри дня — проекты (по сколько аккаунтов и очков от каждого).
  const byDay = new Map<string, ApiUsageDay>();
  for (const row of rows) {
    const day = byDay.get(row.usedOn) ?? {
      usedOn: row.usedOn,
      activations: 0,
      tokens: 0,
      projects: [],
    };
    day.activations += row.activations;
    day.tokens += row.tokens;
    day.projects.push({
      projectId: row.projectId,
      projectName: row.projectName,
      activations: row.activations,
      tokens: row.tokens,
    });
    byDay.set(row.usedOn, day);
  }
  return [...byDay.values()];
}

/**
 * Суммы по дням: сколько активаций, сколько разных проектов задействовано и
 * сколько токенов потрачено (заказ владельца 05.11).
 *
 * Считается ЧИСТОЙ функцией `aggregateDailyUsage` по сырым строкам журнала —
 * ровно той, что покрыта юнит-гейтом `lib/accounts/stats.test.ts`. Считать то
 * же самое дважды (здесь и в компоненте) нельзя: числа на экране разъедутся с
 * проверенными.
 */
export async function dailyUsage(user: SessionUser): Promise<DailyUsage[]> {
  const rows = await db
    .select({
      usedOn: accountsUsage.usedOn,
      projectId: accountsUsage.projectId,
      tokens: accountsUsage.tokens,
    })
    .from(accountsUsage)
    .where(ownership(user, accountsUsage.userId));
  return aggregateDailyUsage(rows);
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
