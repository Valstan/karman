import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  accountsAccount,
  accountsProject,
  accountsUsage,
  authUser,
  secretsProject,
} from '@/lib/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import { resolveApiToken } from '@/lib/services/secrets/token';
import { logAudit } from '@/lib/services/secrets/internal';
import { accountPassword, activateAccount, listAccounts } from '@/lib/services/accounts';
import { isSpent, moscowToday } from '@/lib/accounts/rotation';
import { weeklyQuota } from '@/lib/accounts/weekly';
import {
  buildOffer,
  pickPoolAccount,
  resolveActivation,
  type PoolOffer,
} from '@/lib/accounts/pool';

/**
 * Машинный доступ к пулу MiniMax (заказ владельца 13.11).
 *
 * ## Что это
 *
 * Сарафан (и любой другой проект с токеном комнаты) приходит по HTTP за аккаунтом:
 *
 * - `GET /api/minimax/accounts/available` → **один** аккаунт — тот же верхний слот,
 *   что и в интерфейсе владельца, — с почтой, паролем, ожидаемой клеткой и ожидаемыми
 *   очками;
 * - `POST /api/minimax/activations` → запись факта: аккаунт активирован, вот столько
 *   очков, вот какая клетка была на панели.
 *
 * Учёт при этом НЕ переписывается: подбор — `lib/accounts/rotation.ts`, клетка и очки —
 * `lib/accounts/weekly.ts`, запись — тот же `activateAccount`, что и кнопка владельца.
 * Разница одна: пишущий теперь не только человек, но и проект.
 *
 * ## Правило одной правды (правило владельца, мандат brain 13.11)
 *
 * «Аккаунт, активированный в одном проекте, не должен предлагаться в те же сутки
 * другому». Значит запись активации привязана к проекту: повтор от ТОГО ЖЕ проекта —
 * обновление строки, повтор от ДРУГОГО — **409**. Гонка двух проектов за один аккаунт
 * не может дать две правды: вторая получает отказ и берёт другой аккаунт.
 *
 * ## Кто может звать
 *
 * Токен комнаты **с правом записи** (`can_write`): выдача аккаунта отдаёт учётные данные
 * и пишет в журнал — это операция класса записи. Read-only токен → 403. Каждая выдача и
 * каждая запись попадают в аудит комнаты (`secrets_audit`), без пароля.
 *
 * ## Пул и его владелец
 *
 * Пул принадлежит владельцу комнаты (`secrets_project.user_id`): комната — его, значит
 * и аккаунты — его. Проект получает аккаунт из пула своего владельца, а не чужого.
 */

export type PoolCallError = {
  status: 401 | 403 | 404 | 409 | 500;
  error: string;
};

/** Кто зовёт: комната, её владелец и «проект» для журнала активаций. */
export type PoolCaller = {
  roomId: number;
  roomSlug: string;
  roomName: string;
  /** Владелец комнаты — владелец пула аккаунтов. */
  owner: SessionUser;
  /** Проект в журнале активаций (`accounts_project`), кому уходят очки. */
  projectId: number;
  projectName: string;
  tokenId: number;
  actor: string;
};

/** Сессия владельца по его id: поля нужны только для `ownership` (это `user.id`). */
function ownerSession(owner: {
  id: number;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  isSuperuser: boolean;
}): SessionUser {
  return {
    id: owner.id,
    username: owner.username,
    email: owner.email,
    firstName: owner.firstName,
    lastName: owner.lastName,
    isSuperuser: owner.isSuperuser,
  };
}

/**
 * Проект журнала для комнаты.
 *
 * Имена проектов у владельца свои («Сабантуй», «Матрица РМЗ»), а имя комнаты —
 * каноническое имя проекта из реестра Мозга («SARAFAN», «GONBA»). Сопоставляем по
 * имени без учёта регистра; если такого проекта ещё нет — заводим: иначе очки Сарафана
 * лягут «в никуда» и владелец не увидит, куда ушла активация.
 */
async function ensureJournalProject(ownerId: number, name: string): Promise<{ id: number; name: string }> {
  const [existing] = await db
    .select({ id: accountsProject.id, name: accountsProject.name })
    .from(accountsProject)
    .where(and(eq(accountsProject.userId, ownerId), sql`lower(${accountsProject.name}) = lower(${name})`))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(accountsProject)
    .values({ userId: ownerId, name })
    .returning({ id: accountsProject.id, name: accountsProject.name });
  return created ?? { id: 0, name };
}

/** Разбор токена комнаты: кто зовёт, чей пул, кому в журнал. */
async function resolveCaller(
  rawToken: string,
  ip: string | null,
): Promise<{ ok: true; caller: PoolCaller } | { ok: false; error: PoolCallError }> {
  const resolved = await resolveApiToken(rawToken);
  if (!resolved.ok) {
    await logAudit(resolved.projectId, resolved.tokenId, 'minimax_denied', resolved.reason, ip);
    return { ok: false, error: { status: 401, error: 'Недействительный токен' } };
  }
  const tok = resolved.token;
  if (!tok.canWrite) {
    await logAudit(tok.projectId, tok.id, 'minimax_denied', 'токен только для чтения', ip, resolved.actor);
    return { ok: false, error: { status: 403, error: 'Нужен токен комнаты с правом записи' } };
  }

  const [room] = await db
    .select({
      id: secretsProject.id,
      slug: secretsProject.slug,
      name: secretsProject.name,
      userId: secretsProject.userId,
    })
    .from(secretsProject)
    .where(eq(secretsProject.id, tok.projectId))
    .limit(1);
  if (!room) return { ok: false, error: { status: 401, error: 'Недействительный токен' } };

  const [ownerRow] = await db
    .select({
      id: authUser.id,
      username: authUser.username,
      email: authUser.email,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      isSuperuser: authUser.isSuperuser,
    })
    .from(authUser)
    .where(eq(authUser.id, room.userId))
    .limit(1);
  if (!ownerRow) return { ok: false, error: { status: 401, error: 'У комнаты нет владельца' } };

  const owner = ownerSession(ownerRow);
  const project = await ensureJournalProject(owner.id, room.name);

  return {
    ok: true,
    caller: {
      roomId: room.id,
      roomSlug: room.slug,
      roomName: room.name,
      owner,
      projectId: project.id,
      projectName: project.name,
      tokenId: tok.id,
      actor: resolved.actor,
    },
  };
}

/**
 * «Дай аккаунт» — один лучший по нашим правилам, с учётными данными и подсказкой
 * по очкам.
 *
 * Ответ без аккаунта — честная пустота (`reason: no_free_accounts`), а не 404 и не 500:
 * «сегодня аккаунтов нет» и «сервис сломался» — разные вещи, и проект должен различать
 * их (иначе общий предохранитель у соседей выключает контур из-за одного аккаунта).
 */
export async function issueAccount(
  rawToken: string,
  ip: string | null,
  now: Date = new Date(),
): Promise<{ ok: true; offer: PoolOffer } | { ok: false; error: PoolCallError }> {
  const callerResult = await resolveCaller(rawToken, ip);
  if (!callerResult.ok) return callerResult;
  const caller = callerResult.caller;

  const accounts = await listAccounts(caller.owner, now);
  const picked = pickPoolAccount(accounts, now);
  const today = moscowToday(now);

  if (!picked.account) {
    await logAudit(
      caller.roomId,
      caller.tokenId,
      'minimax_no_accounts',
      `свободных аккаунтов нет (свободно ${picked.free}, скоро освободятся ${picked.soon})`,
      ip,
      caller.actor,
    );
    return {
      ok: true,
      offer: buildOffer(picked, {
        password: null,
        quota: null,
        project: caller.projectName,
        today,
      }),
    };
  }

  const account = picked.account;
  const full = accounts.find((row) => row.id === account.id) ?? null;
  const password = await accountPassword(caller.owner, account.id);
  const offer = buildOffer(picked, {
    password,
    quota: full?.week ?? null,
    project: caller.projectName,
    today,
  });

  // В аудит — без пароля: что за аккаунт, кому и с каким прогнозом очков.
  await logAudit(
    caller.roomId,
    caller.tokenId,
    'minimax_account_issued',
    `выдан аккаунт #${account.id} «${account.title}»: клетка ${offer.account?.activation_index ?? '-'}, очки ${offer.account?.points_next ?? '-'}`,
    ip,
    caller.actor,
  );

  return { ok: true, offer };
}

/** Что записать по ответу проекта и что получилось. */
export type ActivationRecord = {
  account_id: number;
  used_on: string;
  /** Клетка в журнале после записи. */
  activation_index: number | null;
  /** Очки в журнале после записи. */
  points: number;
  /** Очки, которые мы предсказывали в раздаче (для сверки). */
  points_expected: number | null;
  /** Разошёлся ли факт с предсказанием — сигнал, а не ошибка. */
  mismatch: boolean;
  /** Откуда взялись очки: назвал проект / прислал проект / посчитали сами. */
  source: 'client_index' | 'client_points' | 'computed';
  /** Обновили ли уже существующую строку дня (повтор от того же проекта). */
  updated: boolean;
  project: string;
};

/**
 * «Активация сделана» — запись факта от проекта.
 *
 * - повтор от ТОГО ЖЕ проекта → обновление строки дня (идемпотентно);
 * - повтор от ДРУГОГО проекта → **409**: аккаунт уже отработан сегодня, бери другой;
 * - аккаунт в окне (5 ч после прошлой активации) → **409**: он сейчас в работе.
 *
 * Правило клетки при этом НЕ трогается: номер, названный проектом, ложится в журнал
 * тем же полем, что и номер владельца («названный панелью»), а модель (номер по датам)
 * остаётся прежней. Расхождение с нашим предсказанием — сигнал для разбора (аккаунт
 * 3@), а не повод молча «поправить» счёт.
 */
export async function recordActivation(
  rawToken: string,
  ip: string | null,
  input: { accountId: number; points?: number | null; activationIndex?: number | null },
  now: Date = new Date(),
): Promise<{ ok: true; record: ActivationRecord } | { ok: false; error: PoolCallError }> {
  const callerResult = await resolveCaller(rawToken, ip);
  if (!callerResult.ok) return callerResult;
  const caller = callerResult.caller;
  const today = moscowToday(now);

  const [account] = await db
    .select({
      id: accountsAccount.id,
      usedOn: accountsAccount.usedOn,
      usedAt: accountsAccount.usedAt,
    })
    .from(accountsAccount)
    .where(and(eq(accountsAccount.id, input.accountId), eq(accountsAccount.userId, caller.owner.id)))
    .limit(1);
  if (!account) {
    await logAudit(
      caller.roomId,
      caller.tokenId,
      'minimax_denied',
      `аккаунт #${input.accountId} в пуле не найден`,
      ip,
      caller.actor,
    );
    return { ok: false, error: { status: 404, error: 'Аккаунт не найден в пуле' } };
  }

  const [existing] = await db
    .select({
      id: accountsUsage.id,
      projectId: accountsUsage.projectId,
      tokens: accountsUsage.tokens,
      activationIndex: accountsUsage.activationIndex,
    })
    .from(accountsUsage)
    .where(
      and(
        eq(accountsUsage.accountId, input.accountId),
        eq(accountsUsage.usedOn, today),
        eq(accountsUsage.userId, caller.owner.id),
      ),
    )
    .limit(1);

  const sameProject = existing !== undefined && existing.projectId === caller.projectId;
  if (existing && !sameProject) {
    await logAudit(
      caller.roomId,
      caller.tokenId,
      'minimax_conflict',
      `аккаунт #${input.accountId} за ${today} уже записан за другим проектом`,
      ip,
      caller.actor,
    );
    return {
      ok: false,
      error: {
        status: 409,
        error: 'Аккаунт уже активирован сегодня другим проектом — возьми другой',
      },
    };
  }

  // Аккаунт в окне (5 ч после прошлой активации) — он сейчас в работе; отдать его
  // другому проекту нельзя. Повтор от того же проекта — не отказ (идемпотентность).
  if (!sameProject && isSpent({ usedAt: account.usedAt }, now)) {
    await logAudit(
      caller.roomId,
      caller.tokenId,
      'minimax_conflict',
      `аккаунт #${input.accountId} занят окном (активирован ${account.usedAt ?? '-'})`,
      ip,
      caller.actor,
    );
    return { ok: false, error: { status: 409, error: 'Аккаунт сейчас занят (окно 5 часов)' } };
  }

  const checkIns = await db
    .select({ usedOn: accountsUsage.usedOn, activationIndex: accountsUsage.activationIndex })
    .from(accountsUsage)
    .where(and(eq(accountsUsage.accountId, input.accountId), eq(accountsUsage.userId, caller.owner.id)));
  const quota = weeklyQuota(
    checkIns.map((row) => ({ date: row.usedOn, index: row.activationIndex })),
    today,
  );

  // Наше предсказание ДО записи: во что мы ждали очков и какую клетку.
  // При повторе от того же проекта предсказание — то, что уже записано: иначе
  // квота уже учла сегодняшний чек-ин и «предсказала» бы следующую клетку.
  const expectedPrediction = existing
    ? { points: existing.tokens, index: existing.activationIndex }
    : quota.nextIndex !== null
      ? { points: quota.pointsToday, index: quota.nextIndex }
      : { points: null, index: null };

  const resolution = resolveActivation(input, quota, expectedPrediction);

  // Запись — тем же путём, что и кнопка «Активировать» у владельца:
  //   • назван номер клетки → очки считаются по нему (4-я и 7-я — 1000);
  //   • присланы очки → пишем их (факт панели), клетку считаем сами;
  //   • ничего → считаем сами по недельной квоте (пустые поля = «не меняю»).
  const written = await activateAccount(
    caller.owner,
    {
      id: input.accountId,
      projectId: caller.projectId,
      ...(resolution.source === 'client_index'
        ? { activationIndex: resolution.index ?? undefined }
        : resolution.source === 'client_points'
          ? { tokens: resolution.points }
          : {}),
    },
    now,
  );
  if (!written) {
    return { ok: false, error: { status: 404, error: 'Аккаунт не найден в пуле' } };
  }

  // Что записалось на самом деле — читаем журнал, а не доверяем расчёту.
  const [row] = await db
    .select({
      usedOn: accountsUsage.usedOn,
      tokens: accountsUsage.tokens,
      activationIndex: accountsUsage.activationIndex,
    })
    .from(accountsUsage)
    .where(
      and(
        eq(accountsUsage.accountId, input.accountId),
        eq(accountsUsage.usedOn, today),
        eq(accountsUsage.userId, caller.owner.id),
      ),
    )
    .limit(1);

  const points = row?.tokens ?? resolution.points;
  const index = row?.activationIndex ?? resolution.index;
  const expectedPoints = expectedPrediction.points;
  // Расхождение с предсказанием — сигнал (независимое показание по клетке), а не
  // ошибка: модель клетки отсюда не меняется.
  const mismatch =
    resolution.mismatch ||
    (expectedPoints !== null && expectedPoints !== points) ||
    (resolution.source === 'client_index' &&
      expectedPrediction.index !== null &&
      expectedPrediction.index !== resolution.index);

  await logAudit(
    caller.roomId,
    caller.tokenId,
    'minimax_activation_recorded',
    `аккаунт #${input.accountId}: клетка ${index ?? '-'}, очки ${points}${mismatch ? ' (расходится с предсказанием)' : ''}`,
    ip,
    caller.actor,
  );

  return {
    ok: true,
    record: {
      account_id: input.accountId,
      used_on: row?.usedOn ?? today,
      activation_index: index,
      points,
      points_expected: expectedPoints,
      mismatch,
      source: resolution.source,
      updated: existing !== undefined,
      project: caller.projectName,
    },
  };
}
