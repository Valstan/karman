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
import { activateAccount, listAccounts } from '@/lib/services/accounts';
import {
  ensureLiveAccessToken,
  markAccessHandedOver,
  renewAccountToken,
  tokenBackedAccountIds,
  type AccessHandover,
} from '@/lib/services/account-tokens';
import { moscowToday } from '@/lib/accounts/rotation';
import {
  dailyStateFor,
  timezoneForRoom,
} from '@/lib/services/minimax-daily';
import { pointsForIndex, weeklyQuota } from '@/lib/accounts/weekly';
import {
  buildOffer,
  pickPoolAccount,
  poolTierOf,
  resolveActivation,
  type PoolFilters,
  type PoolOffer,
  type PoolTier,
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
 *   очков, вот какая клетка была на панели;
 * - `POST /api/minimax/renew` → **продление цепочки**: тот же аккаунт, свежий access
 *   (D-219, мандат владельца 17.11).
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
  status: 400 | 401 | 403 | 404 | 409 | 500;
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
 * Приоритет класса очков по потребителю.
 *
 * Мандат владельца (14.11, 00:30 МСК): «Сарафану в приоритете предлагать 400 очковые
 * токены, если нету то 1000-е предлагать, а панели программирования предлагать в
 * приоритете 1000 токоны, а если нет то 400 очковые». Ключ — slug комнаты-потребителя.
 *
 * Кто спрашивает — не решает: выбор класса делаем мы (учёт и ротация — наши), поэтому
 * потребитель никакого параметра не передаёт.
 */
const TIER_PREFERENCE: Record<string, PoolTier> = {
  /** Сарафан (фильтрация постов ВК): сначала четырёхсотовые. */
  setka: 'points_400',
  /** Панель программирования (Мозг): сначала тысячные. */
  brain: 'points_1000',
};

/** Приоритет по умолчанию (проекты вообще): четырёхсотовые — как решил владелец 13.11. */
const DEFAULT_TIER_PREFERENCE: PoolTier = 'points_400';

/**
 * Наблюдение потребителя: сколько очков было на выданном токене.
 *
 * Заказ владельца (14.11, 01:10 МСК): «принимай от панели программирования и от сарафана
 * ответки о том сколько они очков на токене только что полученном активировали чекнули,
 * ну чтобы ты подтверждал свою статистику предсказание по очкам или подкорректировал ее
 * если у тебя неправильно предсказано было по токену».
 *
 * Что это НЕ: потребитель не пишет в наш учёт. Активацию, окно и статистику ведём мы —
 * он присылает только **факт**, который видел на панели MiniMax: сколько очков было на
 * токене (и, если знает, номер клетки). Факт ложится в журнал как истина, расхождение с
 * нашим предсказанием возвращается ему флагом (это второй источник по вопросу о клетке
 * после пропущенного дня).
 *
 * Цепочка токенов при этом неприкосновенна: refresh не принимается и не отдаётся.
 */
export async function recordObservation(
  rawToken: string,
  ip: string | null,
  input: {
    accountId?: number | null;
    email?: string | null;
    points?: number | null;
    activationIndex?: number | null;
  },
  now: Date = new Date(),
): Promise<{ ok: true; record: ObservationRecord } | { ok: false; error: PoolCallError }> {
  const callerResult = await resolveCaller(rawToken, ip);
  if (!callerResult.ok) return callerResult;
  const caller = callerResult.caller;
  const today = moscowToday(now);

  if ((input.accountId === undefined || input.accountId === null) && !input.email) {
    return {
      ok: false,
      error: { status: 400, error: 'Нужен account_id или email аккаунта' },
    };
  }

  // Аккаунт по id ИЛИ по почте: проект не обязан знать наши внутренние id.
  const [byId] = input.accountId
    ? await db
        .select({ id: accountsAccount.id })
        .from(accountsAccount)
        .where(
          and(
            eq(accountsAccount.id, input.accountId),
            eq(accountsAccount.userId, caller.owner.id),
          ),
        )
        .limit(1)
    : [];
  const [byEmail] = input.email
    ? await db
        .select({ id: accountsAccount.id })
        .from(accountsAccount)
        .where(
          and(
            sql`lower(${accountsAccount.email}) = lower(${input.email})`,
            eq(accountsAccount.userId, caller.owner.id),
          ),
        )
        .limit(1)
    : [];
  const account = byId ?? byEmail;
  if (!account) {
    await logAudit(
      caller.roomId,
      caller.tokenId,
      'minimax_denied',
      `аккаунт ${input.accountId ?? input.email ?? '?'} в пуле не найден`,
      ip,
      caller.actor,
    );
    return { ok: false, error: { status: 404, error: 'Аккаунт не найден в пуле' } };
  }
  const accountId = account.id;

  // Строку дня записывали МЫ при выдаче. Если её нет — мы этот аккаунт сегодня проекту
  // не выдавали, и наблюдать тут нечего.
  const [row] = await db
    .select({
      id: accountsUsage.id,
      tokens: accountsUsage.tokens,
      activationIndex: accountsUsage.activationIndex,
    })
    .from(accountsUsage)
    .where(
      and(
        eq(accountsUsage.accountId, accountId),
        eq(accountsUsage.usedOn, today),
        eq(accountsUsage.userId, caller.owner.id),
      ),
    )
    .limit(1);
  if (!row) {
    return {
      ok: false,
      error: { status: 404, error: 'Активация за сегодня не найдена — мы его не выдавали' },
    };
  }

  // Наше предсказание ДО наблюдения: по нему видно, разошёлся ли факт с моделью.
  const checkIns = await db
    .select({ usedOn: accountsUsage.usedOn, activationIndex: accountsUsage.activationIndex })
    .from(accountsUsage)
    .where(
      and(
        eq(accountsUsage.accountId, accountId),
        eq(accountsUsage.userId, caller.owner.id),
      ),
    );
  const quota = weeklyQuota(
    checkIns.map((r) => ({ date: r.usedOn, index: r.activationIndex })),
    today,
  );
  const expectedIndex = quota.nextIndex ?? null;
  const expectedPoints = expectedIndex !== null ? pointsForIndex(expectedIndex) : null;
  const resolution = resolveActivation(
    { points: input.points ?? null, activationIndex: input.activationIndex ?? null },
    quota,
    { points: expectedPoints, index: expectedIndex },
  );

  // Факт — истина: правим свои числа (очки и клетку). Проект, метка и окно — наши.
  await db
    .update(accountsUsage)
    .set({ tokens: resolution.points, activationIndex: resolution.index })
    .where(eq(accountsUsage.id, row.id));
  await db
    .update(accountsAccount)
    .set({ lastTokens: resolution.points })
    .where(eq(accountsAccount.id, accountId));

  const cellMismatch =
    expectedIndex !== null &&
    resolution.index !== null &&
    expectedIndex !== resolution.index;
  const pointsMismatch =
    expectedPoints !== null && expectedPoints !== resolution.points;

  await logAudit(
    caller.roomId,
    caller.tokenId,
    'minimax_observed',
    `наблюдение по аккаунту #${accountId}: очки ${resolution.points}, клетка ${
      resolution.index ?? '-'
    }${cellMismatch || pointsMismatch ? ' — расходится с предсказанием' : ''}`,
    ip,
    caller.actor,
  );

  return {
    ok: true,
    record: {
      account_id: accountId,
      used_on: today,
      activation_index: resolution.index,
      points: resolution.points,
      points_expected: expectedPoints,
      cell_expected: expectedIndex,
      cell_mismatch: cellMismatch,
      points_mismatch: pointsMismatch,
      mismatch: cellMismatch || pointsMismatch,
      source: resolution.source,
      project: caller.projectName,
    },
  };
}

/** Что прислал потребитель и что из этого вышло. */
export type ObservationRecord = {
  account_id: number;
  used_on: string;
  activation_index: number | null;
  points: number;
  points_expected: number | null;
  cell_expected: number | null;
  cell_mismatch: boolean;
  points_mismatch: boolean;
  mismatch: boolean;
  source: 'client_index' | 'client_points' | 'computed';
  project: string;
};

/**
 * «Дай аккаунт» — один лучший по нашим правилам, с подсказкой по очкам.
 *
 * **Пароля в ответе нет.** Сарафан (13.11, линия «Телефона»): «мы берём аккаунт по
 * ПОЧТЕ… программного логина по паролю у MiniMax нет (grant_type=password → 400),
 * поэтому пароль из ответа нам не нужен, учётные данные не храним и в лог не берём».
 * Значит отдавать пароль — значит выносить секрет из vault в чужое окружение без
 * причины. Не выносим.
 *
 * **Фильтры запроса** (то, о чём просили: «нужен способ его пропустить»):
 * - `excludeIds` — id аккаунтов, которые проекту не подходят (он их уже пробовал);
 * - `emails` — почты, которые у проекта есть: отдаём только такие аккаунты.
 *
 * Ответ без аккаунта — честная пустота (`reason: no_free_accounts`), а не 404 и не 500:
 * «сегодня аккаунтов нет» и «сервис сломался» — разные вещи, и проект должен различать
 * их (иначе общий предохранитель у соседей выключает контур из-за одного аккаунта).
 */
export async function issueAccount(
  rawToken: string,
  ip: string | null,
  filters: PoolFilters = {},
  now: Date = new Date(),
): Promise<{ ok: true; offer: PoolOffer } | { ok: false; error: PoolCallError }> {
  const callerResult = await resolveCaller(rawToken, ip);
  if (!callerResult.ok) return callerResult;
  const caller = callerResult.caller;

  const accounts = await listAccounts(caller.owner, now, { timezoneId: timezoneForRoom(caller.roomSlug) });
  // Отдаём только аккаунты, у которых пара токенов ЕСТЬ: протухший access мы
  // оживим по refresh при выдаче (refresh остаётся у нас), а аккаунт без пары
  // проекту бесполезен — вход в MiniMax делает владелец.
  const tokenBacked = await tokenBackedAccountIds();
  // Класс очков выбираем МЫ — по потребителю (см. TIER_PREFERENCE); потребитель в
  // этом не участвует и никаких параметров не задаёт.
  const preferredTier = TIER_PREFERENCE[caller.roomSlug] ?? DEFAULT_TIER_PREFERENCE;
  const today = moscowToday(now);
  // Пояс потребителя: его «сегодня» и наше «сегодня» — разные дни в ночном
  // окне между 00:00 и 03:00 МСК, поэтому состояние панели берём для ЕГО пояса.
  const consumerTimezone = timezoneForRoom(caller.roomSlug);

  // Кандидатов перебираем: аккаунт может оказаться непригодным (цепочка токенов
  // оборвана) или его только что забрал другой проект — тогда берём следующего, а
  // не отдаём потребителю пустоту.
  const excluded = new Set(filters.excludeIds ?? []);
  const pick = () =>
    pickPoolAccount(accounts, now, {
      ...filters,
      excludeIds: [...excluded],
      tier: preferredTier,
      tokenReadyIds: tokenBacked,
    });
  let picked = pick();
  let handover: AccessHandover | null = null;
  for (let attempt = 0; attempt < 5 && picked.account; attempt += 1) {
    const candidate = picked.account;
    // 1) Токен: протухший access оживляем по refresh; оборванная цепочка — кандидат
    //    негоден, идём к следующему.
    const token = await ensureLiveAccessToken(candidate.id, now);
    if (!token) {
      excluded.add(candidate.id);
      picked = pick();
      continue;
    }
    // 1.5) Панель MiniMax: у потребителя в ЕГО сутках клетка уже забрана — значит
    //      очков он не получит («insufficient balance»). Проверка только чтение,
    //      очки при этом не тратятся. Панель не ответила — решает наша эвристика
    //      ночной границы (не знаем — не отказываем).
    const state = await dailyStateFor(candidate.id, consumerTimezone, now, {
      userId: caller.owner.id,
    });
    if (state && !state.can_claim) {
      excluded.add(candidate.id);
      picked = pick();
      continue;
    }
    // Ответ панели — источник правды про очки. Обещаем потребителю ровно то,
    // что подтвердила панель: модель по датам с панелью разошлась (живая
    // сверка 16.11: класс очков расходится у 48 аккаунтов из 109), и
    // обещание «1000 очков» от модели оказалось бы пустым — Мозг получил бы
    // «тысячный» аккаунт, который даёт 400.
    if (state) {
      const verified = {
        ...candidate,
        panelStatus: state.status,
        panelPoints: state.points,
        panelCellNo: state.cell_no,
        panelCheckedAt: state.checked_at,
      };
      picked = { ...picked, account: verified, tier: poolTierOf(verified, now) };
    }
    // 2) Захват аккаунта: если его только что забрал другой проект — тоже идём к
    //    следующему (гонка закрыта на уровне БД, `onlyIfFree`).
    //
    //    Номер клетки в журнал пишем **ИЗ ПАНЕЛИ** (когда панель ответила): наша
    //    модель по датам с панелью расходится (живая сверка 16.11 — 42 из 112), а
    //    журнал должен хранить правду — иначе отчёт по очкам и предсказания для
    //    следующей активации считаются по догадке.
    const claimed = await activateAccount(
      caller.owner,
      {
        id: candidate.id,
        projectId: caller.projectId,
        source: 'api',
        ...(state ? { activationIndex: state.cell_no } : {}),
      },
      now,
      { onlyIfFree: true },
    );
    if (!claimed) {
      excluded.add(candidate.id);
      picked = pick();
      continue;
    }
    handover = token;
    // Клетку только что забрали — ответ панели помечен «очки сожжены» (это делает
    // activateAccount: панель об этом ещё не знает, а обещать «очки есть» нельзя).
    break;
  }

  if (!picked.account || !handover) {
    await logAudit(
      caller.roomId,
      caller.tokenId,
      'minimax_no_accounts',
      `свободных аккаунтов нет (свободно ${picked.free}, скоро освободятся ${picked.soon}${
        filters.excludeIds?.length ? `, исключено ${filters.excludeIds.length}` : ''
      })`,
      ip,
      caller.actor,
    );
    return {
      ok: true,
      offer: buildOffer(
        { ...picked, account: null, tier: null, reason: picked.reason ?? 'no_free_accounts' },
        { project: caller.projectName, today, now },
      ),
    };
  }

  const account = picked.account;
  const offer = buildOffer(picked, {
    project: caller.projectName,
    today,
    now,
  });
  // Аккаунт только что погас — в счётчике свободных он больше не числится.
  offer.free = Math.max(0, offer.free - 1);

  // Токен агента — отдаём ТОЛЬКО access (мандат владельца 14.11: «отдавай ему
  // только по одному токену»). Refresh остаётся у нас: он одноразовый, и второй
  // раз отдать его проект не должен. Цепочка токенов — наша, её продлением
  // занимаемся мы, а не потребитель.
  await markAccessHandedOver(account.id, now);
  offer.access_token = handover.access_token;
  offer.expires_at_ms = handover.expires_at_ms;

  // В аудит — без токена: что за аккаунт, кому, с каким прогнозом очков.
  await logAudit(
    caller.roomId,
    caller.tokenId,
    'minimax_account_issued',
    `выдан аккаунт #${account.id} «${account.title}»: класс ${picked.tier ?? '-'}, клетка ${
      offer.account?.activation_index ?? '-'
    }, очки ${offer.account?.points_next ?? '-'}, access отдан${
      filters.area ? `, область ${filters.area}` : ''
    }${filters.project ? `, проект ${filters.project}` : ''}, приоритет ${preferredTier}, жизнь access ${
      Math.round((handover.expires_at_ms - now.getTime()) / 60000)
    } мин`,
    ip,
    caller.actor,
  );

  return { ok: true, offer };
}

/** Что отдаём при продлении цепочки. */
export type RenewResult = {
  account_id: number;
  email: string;
  /** Только access: refresh остаётся у нас (мандат владельца 14.11, D-219). */
  access_token: string;
  expires_at_ms: number;
  /** true — цепочку продлили новой парой; false — access ещё жил, отдали тот же. */
  renewed: boolean;
};

/**
 * «Продли то, что уже наше» (D-219, мандат владельца 17.11).
 *
 * Мозг: «продлевайте цепочку у себя и отдавайте нам свежий вход того же аккаунта —
 * пара нам не уходит, граница D-219 цела». То есть потребитель возвращается за
 * **тем же** аккаунтом, у которого истёк access, а получает **новый** access.
 *
 * Что здесь важно:
 *
 * - **тот же аккаунт и тот же потребитель.** Аккаунт закреплён за комнатой, которой
 *   мы его выдали (`accounts_account.used_project_id`); чужая комната продлить его
 *   не может — иначе «продление» стало бы вторым путём раздать чужой аккаунт
 *   ([G627]: один аккаунт — один потребитель);
 * - **пара наружу не уходит.** Наружу — только access; refresh остаётся у нас, и
 *   продлеваем цепочку мы (`renewAccountToken`);
 * - **активация не трогается.** Клетка и номинал в докладе активации не меняются:
 *   продление — это про токен, а не про учёт;
 * - **аккаунт — по нашему id, не по почте** (уточнение владельца 17.11): почта это
 *   способ авторизации на сайте MiniMax (вход по коду с почты), а не способ опознать
 *   аккаунт; id потребитель знает — мы отдаём его в ответе выдачи.
 */
export async function renewAccountAccess(
  rawToken: string,
  ip: string | null,
  input: {
    accountId?: number | null;
  },
  now: Date = new Date(),
): Promise<{ ok: true; renewal: RenewResult } | { ok: false; error: PoolCallError }> {
  const callerResult = await resolveCaller(rawToken, ip);
  if (!callerResult.ok) return callerResult;
  const caller = callerResult.caller;

  if (input.accountId === undefined || input.accountId === null) {
    return {
      ok: false,
      error: { status: 400, error: 'Нужен account_id аккаунта' },
    };
  }

  // Аккаунт — ТОЛЬКО по нашему внутреннему id: по почте аккаунт не ищем (почта —
  // это способ авторизации на сайте MiniMax, а не способ опознать аккаунт), а id
  // потребителю отдаём мы сами — в ответе `GET /api/minimax/accounts/available`.
  const [account] = await db
    .select({
      id: accountsAccount.id,
      email: accountsAccount.email,
      usedProjectId: accountsAccount.usedProjectId,
    })
    .from(accountsAccount)
    .where(
      and(
        eq(accountsAccount.id, input.accountId),
        eq(accountsAccount.userId, caller.owner.id),
      ),
    )
    .limit(1);
  if (!account) {
    await logAudit(
      caller.roomId,
      caller.tokenId,
      'minimax_denied',
      `аккаунт ${input.accountId} в пуле не найден`,
      ip,
      caller.actor,
    );
    return { ok: false, error: { status: 404, error: 'Аккаунт не найден в пуле' } };
  }

  // Один аккаунт — один потребитель: продлить может только та комната, которой мы
  // этот аккаунт выдали. Если аккаунт выдавали не этой комнате — отказ.
  if (account.usedProjectId !== caller.projectId) {
    await logAudit(
      caller.roomId,
      caller.tokenId,
      'minimax_denied',
      `продление аккаунта #${account.id} отклонено: аккаунт за другой комнатой`,
      ip,
      caller.actor,
    );
    return {
      ok: false,
      error: {
        status: 409,
        error:
          account.usedProjectId === null
            ? 'Этот аккаунт мы вашей комнате не выдавали — продлевать нечего'
            : 'Этот аккаунт выдан другой комнате — продлить его нельзя',
      },
    };
  }

  const handover = await renewAccountToken(account.id, now);
  if (!handover) {
    await logAudit(
      caller.roomId,
      caller.tokenId,
      'minimax_denied',
      `продление аккаунта #${account.id} невозможно: цепочка токенов оборвана`,
      ip,
      caller.actor,
    );
    return {
      ok: false,
      error: {
        status: 409,
        error: 'Цепочка токенов аккаунта оборвана — нужен новый вход владельца',
      },
    };
  }

  await logAudit(
    caller.roomId,
    caller.tokenId,
    'minimax_account_renewed',
    `продлён аккаунт #${account.id} «${account.email}»: ${
      handover.renewed ? 'цепочка продлена новой парой' : 'access ещё жил, отдан тот же'
    }, access до ${new Date(handover.expires_at_ms).toISOString()}${
      handover.renewed
        ? ` (до продления оставалось ${Math.round(handover.previous_left_ms / 60000)} мин)`
        : ''
    }`,
    ip,
    caller.actor,
  );

  return {
    ok: true,
    renewal: {
      account_id: account.id,
      email: account.email,
      access_token: handover.access_token,
      expires_at_ms: handover.expires_at_ms,
      renewed: handover.renewed,
    },
  };
}
