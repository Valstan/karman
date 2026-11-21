import 'server-only';
import { and, eq, gte, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { accountsAccount, accountsDailyBonus, accountsProject } from '@/lib/db/schema';
import { moscowToday, operationalDayStart } from '@/lib/accounts/rotation';
import { OWNER_TIMEZONE } from '@/lib/minimax/panel';
import {
  CLAIM_RESULT_ALREADY,
  CLAIM_RESULT_CLAIMED,
  claimDailyBonus,
} from '@/lib/minimax/claim';
import { liveAccessToken } from './account-tokens';
import { PACE_WINDOW_DAYS } from '@/lib/accounts/weekly';

/**
 * Ежесуточный забор бонусов MiniMax + забор в момент выдачи.
 *
 * ## Задача
 *
 * «Каждые сутки проходим по всем аккаунтам MiniMax и активируем на них бонусы, заодно
 * записываем у себя в базе, у кого сколько очков сегодня активировалось, а потом в
 * течение дня раздаём эти аккаунты по запросам, зная, по сколько очков отдаём».
 *
 * ## Как это работает
 *
 * 1. **Обход (05:00 МСК).** По каждому аккаунту с живой цепочкой токенов зовём
 *    `POST signin/claim` — забираем сегодняшний бонус. Забор **начисляет** очки, а не
 *    тратит их: сразу после забора клетка имеет `status = 3` (забрано), но `points = 400`
 *    (живая проба 18.11). Позже потребитель заберёт те же очки повторным `claim`
 *    (`claim_result = 2`, `points` прежние) и потратит их работой.
 * 2. **Леджер.** Каждая строка — «аккаунт + московские сутки»: клетка вендора, номинал
 *    очков, результат забора (кто клетку забрал — мы или потребитель), кому и когда отдали.
 * 3. **Раздача.** Забор в МОМЕНТ выдачи (`claimForIssue`): клетку забираем прямо тогда,
 *    когда отдаём аккаунт, и по ответу вендора решаем — отдавать аккаунт или отправить
 *    его в конец очереди (заказ владельца 20.11).
 * 4. **Статистика.** За сутки: сколько бонусов забрали, сколько очков в банке, сколько
 *    отдали, сколько фактически потрачено, сколько осталось неиспользованным.
 *
 * ## Чья это клетка — по идентификатору забора
 *
 * У вендора `claim_id` один на вендорские сутки. Он и есть «счётчик» клетки: если в
 * леджере есть строка с тем же `claim_id` и `claim_result = 1`, значит клетку забрали
 * МЫ (утренний обход или забор при выдаче) — и очки наши и свежие, если её не отдали.
 *
 * Ищем по ВСЕМ датам, а не за текущую: вендорские сутки и наши московские — разные
 * календари. В окне 00:00–03:00 МСК наши сутки уже сменились, а вендорские (UTC) — ещё
 * нет, и забор потребителя в это окно бьёт ровно в клетку, которую мы забрали накануне.
 *
 * ## Почему 05:00 МСК
 *
 * Сутки MiniMax считаются по поясу запроса, и у нас два пояса: московский (владелец) и
 * UTC (потребитель). Их границы — 00:00 и 03:00 МСК. Обход в 05:00 МСК идёт **после
 * обеих**, поэтому «сегодня» у обеих сторон совпадает, и клетка, которую мы забрали, —
 * именно сегодняшняя клетка потребителя.
 *
 * ## Чего модуль НЕ делает
 *
 * - Не тратит очки: забор только начисляет их (см. выше).
 * - Не пишет строки журнала активаций: обход — это не потребительская активация,
 *   аккаунт после обхода остаётся свободным и выдаётся как обычно.
 * - Не трогает учёт: клетка и очки в журнале уточняются сверкой по панели.
 */

/** Итог обхода за сутки. */
export type DailyBonusSweepReport = {
  /** Московская дата суток. */
  date: string;
  /** Сколько аккаунтов прошли обход. */
  accounts: number;
  /** Забрали сейчас (`claim_result = 1`). */
  claimed: number;
  /** Уже было получено сегодня (`claim_result = 2`) — забор идемпотентен. */
  already: number;
  /** Нет живой цепочки токенов — аккаунт пропущен (нужен новый вход владельца). */
  skipped: number;
  /** Вендор не ответил или ответил отказом. */
  failed: number;
  /** Сколько очков в банке по итогу обхода (номинал сегодняшних клеток). */
  points: number;
  /** Клетка → сколько аккаунтов. */
  byCell: Record<number, number>;
  /** Аккаунты, у которых забор удался (забрали или уже было). */
  ids: number[];
};

export type DailyBonusSweepOptions = {
  /** Только этот владелец аккаунтов (по умолчанию — все). */
  userId?: number;
  /** Не больше скольки аккаунтов за обход (0 — без ограничения). Нужен для пробы. */
  limit?: number;
  /** Текущий момент (тесты). */
  now?: Date;
};

/**
 * Обойти аккаунты и забрать сегодняшние бонусы.
 *
 * Аккаунты без живой цепочки токенов пропускаются: забрать бонус без access нельзя,
 * а новый вход делает владелец (device-flow).
 */
export async function sweepDailyBonus(
  options: DailyBonusSweepOptions = {},
): Promise<DailyBonusSweepReport> {
  const now = options.now ?? new Date();
  const date = moscowToday(now);

  const accounts = await db
    .select({ id: accountsAccount.id, userId: accountsAccount.userId })
    .from(accountsAccount)
    .where(
      options.userId === undefined
        ? sql`true`
        : eq(accountsAccount.userId, options.userId),
    )
    .orderBy(accountsAccount.id);

  const report: DailyBonusSweepReport = {
    date,
    accounts: 0,
    claimed: 0,
    already: 0,
    skipped: 0,
    failed: 0,
    points: 0,
    byCell: {},
    ids: [],
  };

  for (const account of accounts) {
    if (options.limit && report.ids.length >= options.limit) break;
    report.accounts += 1;

    // ОДИН сбойный аккаунт не должен обрывать весь обход: у остальных без забора
    // клетка вендора не сдвинется, и серия дней подряд у них порвётся. Поэтому тело
    // аккаунта — в try/catch, а сбой считаем неудачей и идём дальше (живая находка
    // 18.11: исключение на одном аккаунте убивало обход целиком — и сутки обхода
    // терялись целиком).
    try {
      // Живой access: протухший цепочкой обновляем (refresh остаётся у нас), обрубленную
      // цепочку получить нечем — аккаунт пропускаем.
      const access = await liveAccessToken(account.id, now);
      if (!access) {
        report.skipped += 1;
        continue;
      }

      const claim = await claimDailyBonus(access, OWNER_TIMEZONE);
      if (!claim.ok) {
        report.failed += 1;
        continue;
      }

      const { claim_result, claim_id, day_no, points, expire_at_ms, panel } = claim.data;
      const today = panel?.days.find((d) => d.is_today) ?? null;
      await writeBonusRow({
        userId: account.userId,
        accountId: account.id,
        date,
        dayNo: day_no ?? today?.day_no ?? 0,
        points: points ?? today?.points ?? 0,
        status: today?.status ?? 0,
        claimResult: claim_result,
        claimId: claim_id,
        expireAt: expire_at_ms ? new Date(expire_at_ms).toISOString() : null,
        now,
      });

      if (claim_result === CLAIM_RESULT_CLAIMED) report.claimed += 1;
      else if (claim_result === CLAIM_RESULT_ALREADY) report.already += 1;
      else report.failed += 1;

      const cell = day_no ?? today?.day_no ?? 0;
      report.byCell[cell] = (report.byCell[cell] ?? 0) + 1;
      report.points += points ?? today?.points ?? 0;
      report.ids.push(account.id);
    } catch (error) {
      report.failed += 1;
      console.error('[minimax/daily-bonus] аккаунт %d: сбой обхода', account.id, error);
    }
  }

  return report;
}

/** Что записать в строку леджера. */
type BonusRowWrite = {
  userId: number;
  accountId: number;
  /** Московская дата суток (ключ строки). */
  date: string;
  /** Клетка вендора (1..7). */
  dayNo: number;
  /** Номинал клетки. */
  points: number;
  /** Статус клетки панели: 2 — можно забрать, 3 — забрано. */
  status: number;
  /** Результат забора: 1 — забрали мы, 2 — клетку забрали до нас. */
  claimResult: number;
  /** Идентификатор забора вендора (один на вендорские сутки). */
  claimId: string | null;
  /** До какого момента бонус жив. */
  expireAt: string | null;
  now: Date;
};

/**
 * Записать (или обновить) строку леджера.
 *
 * ## Правила
 *
 * 1. **Одна строка — один забор.** Если строка с тем же `claim_id` уже есть, обновляем
 *    её (та же клетка); иначе пишем строку за текущую московскую дату. Так в леджере не
 *    появляется двух строк об одном заборе, и по `claim_id` всегда видно, чья клетка.
 * 2. **«Забрали мы» не понижается.** Повторный забор в те же сутки возвращает 2, и без
 *    этой оговорки наши свежие очки считались бы потраченными, а аккаунты выпадали бы
 *    из выдачи (жалоба владельца 18.11).
 * 3. **Новая клетка — чистая строка.** Если `claim_id` не совпал, строка описывает
 *    ДРУГУЮ клетку: отметка о прежней выдаче (кому и когда отдали) обнуляется — иначе
 *    свежая клетка выглядела бы уже отданной.
 */
async function writeBonusRow(row: BonusRowWrite): Promise<void> {
  // 1. Строка с тем же забором — та же клетка: обновляем её.
  if (row.claimId) {
    const [same] = await db
      .select({
        id: accountsDailyBonus.id,
        claimResult: accountsDailyBonus.claimResult,
        remaining: accountsDailyBonus.remaining,
      })
      .from(accountsDailyBonus)
      .where(
        and(
          eq(accountsDailyBonus.accountId, row.accountId),
          eq(accountsDailyBonus.claimId, row.claimId),
        ),
      )
      .limit(1);
    if (same) {
      const ours =
        row.claimResult === CLAIM_RESULT_CLAIMED || same.claimResult === CLAIM_RESULT_CLAIMED;
      await db
        .update(accountsDailyBonus)
        .set({
          dayNo: row.dayNo,
          points: row.points,
          // Остаток: наша клетка — номинал; чужая — то, что помечено сторожем
          // (0 = «проверено, пусто»), его не затираем.
          remaining: ours ? row.points : same.remaining,
          status: row.status,
          claimResult: ours ? CLAIM_RESULT_CLAIMED : row.claimResult,
          claimId: row.claimId,
          expireAt: row.expireAt,
          checkedAt: row.now.toISOString(),
          // Отметка о выдаче — от ЭТОЙ клетки (claim_id тот же), сохраняем.
        })
        .where(eq(accountsDailyBonus.id, same.id));
      return;
    }
  }

  // 2. Строки с таким забором нет — пишем строку за московскую дату.
  const [existing] = await db
    .select({
      id: accountsDailyBonus.id,
      claimId: accountsDailyBonus.claimId,
      claimResult: accountsDailyBonus.claimResult,
      remaining: accountsDailyBonus.remaining,
      handedAt: accountsDailyBonus.handedAt,
      handedToProjectId: accountsDailyBonus.handedToProjectId,
      handedPoints: accountsDailyBonus.handedPoints,
    })
    .from(accountsDailyBonus)
    .where(
      and(
        eq(accountsDailyBonus.accountId, row.accountId),
        eq(accountsDailyBonus.usedOn, row.date),
      ),
    )
    .limit(1);

  if (!existing) {
    await db.insert(accountsDailyBonus).values({
      userId: row.userId,
      accountId: row.accountId,
      usedOn: row.date,
      dayNo: row.dayNo,
      points: row.points,
      remaining: row.claimResult === CLAIM_RESULT_CLAIMED ? row.points : null,
      status: row.status,
      claimResult: row.claimResult,
      claimId: row.claimId,
      expireAt: row.expireAt,
      claimedAt: row.now.toISOString(),
      checkedAt: row.now.toISOString(),
    });
    return;
  }

  // Та же клетка или другая? От этого зависит, чья отметка о выдаче.
  const sameCell = existing.claimId === row.claimId;
  const ours =
    row.claimResult === CLAIM_RESULT_CLAIMED ||
    (sameCell && existing.claimResult === CLAIM_RESULT_CLAIMED);
  await db
    .update(accountsDailyBonus)
    .set({
      dayNo: row.dayNo,
      points: row.points,
      remaining: ours ? row.points : sameCell ? existing.remaining : null,
      status: row.status,
      claimResult: ours ? CLAIM_RESULT_CLAIMED : row.claimResult,
      claimId: row.claimId,
      expireAt: row.expireAt,
      checkedAt: row.now.toISOString(),
      // Отметка о выдаче относится к ПРЕЖНЕЙ клетке, если клетка сменилась: чистим.
      handedAt: sameCell ? existing.handedAt : null,
      handedToProjectId: sameCell ? existing.handedToProjectId : null,
      handedPoints: sameCell ? existing.handedPoints : null,
    })
    .where(eq(accountsDailyBonus.id, existing.id));
}

/**
 * Кому принадлежит клетка по идентификатору забора вендора.
 *
 * `ours` — клетку забрали мы (утренний обход или забор при выдаче): очки наши, и если
 * их ещё не отдавали (`handed === false`) — свежие.
 *
 * `handed` — эту клетку уже отдавали потребителю: очки могли быть потрачены, отдавать
 * аккаунт второй раз нельзя.
 */
export type ClaimOwnership = {
  ours: boolean;
  handed: boolean;
};

export async function claimOwnership(
  accountId: number,
  claimId: string | null,
): Promise<ClaimOwnership> {
  if (!claimId) return { ours: false, handed: false };
  const rows = await db
    .select({
      claimResult: accountsDailyBonus.claimResult,
      handedAt: accountsDailyBonus.handedAt,
    })
    .from(accountsDailyBonus)
    .where(
      and(
        eq(accountsDailyBonus.accountId, accountId),
        eq(accountsDailyBonus.claimId, claimId),
      ),
    );
  if (rows.length === 0) return { ours: false, handed: false };
  return {
    ours: rows.some((row) => row.claimResult === CLAIM_RESULT_CLAIMED),
    handed: rows.some((row) => row.handedAt !== null),
  };
}

/** Факт забора при выдаче — что вендор ответил и чья это клетка. */
export type IssueClaim = {
  /** Клетку забрали МЫ и её ещё не отдавали → аккаунт можно отдавать. */
  ours: boolean;
  /** Эту клетку уже отдавали потребителю. */
  handed: boolean;
  /** Клетка вендора (1..7). */
  dayNo: number;
  /** Номинал клетки (400 / 1000). */
  points: number;
  /** Идентификатор забора вендора. */
  claimId: string | null;
  /** Результат забора вендора: 1 — забрали, 2 — уже было. */
  claimResult: number;
  /** До какого момента бонус жив (ISO). */
  expireAt: string | null;
};

/**
 * Забрать бонус аккаунта В МОМЕНТ ВЫДАЧИ и понять, чья это клетка.
 *
 * Заказ владельца 20.11: «Просит токен, ты берешь токен, активируешь на нем бонус
 * какой там есть, и если он активировался, то отдаешь потребителю, а если не
 * активировался, то аккаунт отправляешь в конец очереди карусели и берешь новый
 * токен по порядку и снова пытаешься активировать бонус».
 *
 * Возвращает `ours: false`, когда клетку забрали не мы (очки у потребителя и потрачены)
 * или когда её уже отдавали: такой аккаунт уходит в конец очереди, а мы берём следующий.
 *
 * Отказ вендора — это «не знаю», а не «очков нет»: вызывающий решает сам.
 */
export async function claimForIssue(params: {
  userId: number;
  accountId: number;
  access: string;
  timezoneId: string;
  /** Московская дата (ключ строки леджера). */
  date: string;
  now?: Date;
}): Promise<{ ok: true; claim: IssueClaim } | { ok: false; error: 'vendor' }> {
  const now = params.now ?? new Date();
  const claim = await claimDailyBonus(params.access, params.timezoneId);
  if (!claim.ok) return { ok: false, error: 'vendor' };

  const { claim_result, claim_id, day_no, points, expire_at_ms, panel } = claim.data;
  const today = panel?.days.find((day) => day.is_today) ?? null;
  const dayNo = day_no ?? today?.day_no ?? 0;
  const nominal = points ?? today?.points ?? 0;
  const status = today?.status ?? 0;

  // Забрали сейчас — клетка наша, очки свежие (потребитель их ещё не видел).
  // Забрали раньше — смотрим леджер: там видно, наша это клетка и отдавали ли её.
  const ownership =
    claim_result === CLAIM_RESULT_CLAIMED
      ? { ours: true, handed: false }
      : await claimOwnership(params.accountId, claim_id);

  await writeBonusRow({
    userId: params.userId,
    accountId: params.accountId,
    date: params.date,
    dayNo,
    points: nominal,
    status,
    // «Забрали мы» — навсегда наша клетка: повторный забор возвращает 2, и без
    // этой оговорки наши свежие очки считались бы потраченными.
    claimResult: ownership.ours ? CLAIM_RESULT_CLAIMED : CLAIM_RESULT_ALREADY,
    claimId: claim_id,
    expireAt: expire_at_ms ? new Date(expire_at_ms).toISOString() : null,
    now,
  });

  return {
    ok: true,
    claim: {
      ours: ownership.ours,
      handed: ownership.handed,
      dayNo,
      points: nominal,
      claimId: claim_id,
      claimResult: claim_result,
      expireAt: expire_at_ms ? new Date(expire_at_ms).toISOString() : null,
    },
  };
}

/**
 * Очки аккаунта на сегодня из леджера — реальные, а не прогноз модели.
 *
 * null — строки нет (аккаунт сегодня не забирали) или неизвестно.
 */
export async function bonusPointsForAccount(
  accountId: number,
  date: string,
): Promise<{ points: number; remaining: number | null; dayNo: number } | null> {
  const [row] = await db
    .select({
      points: accountsDailyBonus.points,
      remaining: accountsDailyBonus.remaining,
      dayNo: accountsDailyBonus.dayNo,
    })
    .from(accountsDailyBonus)
    .where(
      and(
        eq(accountsDailyBonus.accountId, accountId),
        eq(accountsDailyBonus.usedOn, date),
      ),
    )
    .limit(1);
  if (!row) return null;
  return row;
}

/**
 * Записать выдачу: кому отдали аккаунт и сколько очков он нёс.
 *
 * Пишется в ту же строку леджера, что и забор, — вся история аккаунта за сутки в
 * одном месте.
 *
 * **Строка — по забору, а не по дате.** Отметку о выдаче пишем в строку с тем же
 * `claim_id`: вендорские сутки и наши московские — разные календари (в окне
 * 00:00–03:00 МСК наши сутки уже сменились, а вендорские — ещё нет), и строка «по
 * дате» оказалась бы не про ту клетку. Без `claimId` — по дате (как раньше).
 */
export async function markBonusHanded(
  accountId: number,
  date: string,
  projectId: number | null,
  points: number | null,
  now: Date = new Date(),
  claimId?: string | null,
): Promise<void> {
  const [row] = claimId
    ? await db
        .select({ id: accountsDailyBonus.id })
        .from(accountsDailyBonus)
        .where(
          and(
            eq(accountsDailyBonus.accountId, accountId),
            eq(accountsDailyBonus.claimId, claimId),
          ),
        )
        .limit(1)
    : await db
        .select({ id: accountsDailyBonus.id })
        .from(accountsDailyBonus)
        .where(
          and(
            eq(accountsDailyBonus.accountId, accountId),
            eq(accountsDailyBonus.usedOn, date),
          ),
        )
        .limit(1);
  if (!row) return;
  await db
    .update(accountsDailyBonus)
    .set({
      handedToProjectId: projectId,
      handedAt: now.toISOString(),
      handedPoints: points,
      // Остаток НЕ трогаем: это «сколько очков лежит по нашим данным», а не
      // «сколько отдали». Помечать аккаунт пустым (остаток = 0) — дело сторожа.
    })
    .where(eq(accountsDailyBonus.id, row.id));
}

/** Сводка за сутки: забрали / отдали / потрачено / осталось. */
export type DailyBonusStats = {
  date: string;
  /** Строк в леджере (аккаунтов, чей бонус забирали). */
  accounts: number;
  /** Забрали мы (claim_result = 1). */
  claimed: number;
  /** Уже было получено сегодня. */
  already: number;
  /** Очков в банке (номинал). */
  points: number;
  /** Сколько аккаунтов отдали. */
  handed: number;
  /** Сколько очков отдали. */
  handedPoints: number;
  /** Очки тех аккаунтов, чью клетку забрал потребитель (потрачены). */
  spentPoints: number;
  /** Осталось неиспользованным. */
  leftPoints: number;
  /**
   * Сколько аккаунтов несут тысячные очки — по ЛЕДЖЕРУ (правда), а не по модели
   * клетки: модель с вендором расходилась у 274 строк из 416.
   */
  thousands: number;
  /** Клетка → аккаунтов. */
  byCell: { cell: number; accounts: number; points: number }[];
  /** Комната-потребитель → аккаунтов. */
  byProject: { project: string; accounts: number; points: number }[];
};

/**
 * Статистика за московские сутки.
 *
 * **«Потрачено» — это очки тех аккаунтов, чью клетку забрал НЕ мы** (потребитель):
 * клетка вендора сдвигается только в день использования, поэтому у пропущенного
 * аккаунта клетка стоит на месте и даёт очки, которые потребитель забрал и потратил
 * (возможно, вчера). Панель остатка НЕ показывает (`points` клетки — её номинал),
 * поэтому единственный верный признак — `claim_result` из ответа на забор.
 *
 * «Осталось» — очки, которые забрали мы и которые ещё лежат на аккаунтах (минус
 * отданные потребителям).
 */
export async function dailyBonusStats(
  date: string = moscowToday(),
): Promise<DailyBonusStats> {
  const rows = await db
    .select({
      dayNo: accountsDailyBonus.dayNo,
      points: accountsDailyBonus.points,
      remaining: accountsDailyBonus.remaining,
      claimResult: accountsDailyBonus.claimResult,
      handedAt: accountsDailyBonus.handedAt,
      handedPoints: accountsDailyBonus.handedPoints,
      projectId: accountsDailyBonus.handedToProjectId,
    })
    .from(accountsDailyBonus)
    .where(eq(accountsDailyBonus.usedOn, date));

  const ours = rows.filter((r) => r.claimResult === CLAIM_RESULT_CLAIMED);
  const theirs = rows.filter((r) => r.claimResult !== CLAIM_RESULT_CLAIMED);
  const stats: DailyBonusStats = {
    date,
    accounts: rows.length,
    claimed: ours.length,
    already: theirs.length,
    points: ours.reduce((sum, r) => sum + r.points, 0),
    handed: rows.filter((r) => r.handedAt !== null).length,
    handedPoints: rows.reduce((sum, r) => sum + (r.handedPoints ?? 0), 0),
    // Очки, ушедшие к потребителю без нашего забора: их клетку забрали и потратили
    // без нас (обычно — ночью, пока аккаунт не использовали).
    spentPoints: theirs.reduce((sum, r) => sum + r.points, 0),
    // Тысячные — по номиналу клетки из леджера (ответ вендора), а не по модели.
    thousands: rows.filter((r) => r.points >= 1000).length,
    leftPoints: Math.max(
      0,
      ours.reduce((sum, r) => sum + r.points, 0) -
        rows.reduce((sum, r) => sum + (r.handedPoints ?? 0), 0),
    ),
    byCell: [],
    byProject: [],
  };

  const cells = new Map<number, { accounts: number; points: number }>();
  for (const row of rows) {
    const cell = cells.get(row.dayNo) ?? { accounts: 0, points: 0 };
    cell.accounts += 1;
    cell.points += row.points;
    cells.set(row.dayNo, cell);
  }
  stats.byCell = [...cells.entries()]
    .map(([cell, v]) => ({ cell, ...v }))
    .sort((a, b) => a.cell - b.cell);

  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((v): v is number => v !== null))];
  const projects = projectIds.length
    ? await db
        .select({ id: accountsProject.id, name: accountsProject.name })
        .from(accountsProject)
        .where(inArray(accountsProject.id, projectIds))
    : [];
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  const byProject = new Map<string, { accounts: number; points: number }>();
  for (const row of rows) {
    if (row.handedAt === null) continue;
    const name = row.projectId === null ? '(без комнаты)' : (nameById.get(row.projectId) ?? '—');
    const item = byProject.get(name) ?? { accounts: 0, points: 0 };
    item.accounts += 1;
    item.points += row.handedPoints ?? 0;
    byProject.set(name, item);
  }
  stats.byProject = [...byProject.entries()]
    .map(([project, v]) => ({ project, ...v }))
    .sort((a, b) => b.accounts - a.accounts);

  return stats;
}

/**
 * Сводка по **операционным суткам** — окну 05:00→05:00 МСК (заказ владельца 21.11).
 *
 * ## Почему не календарный день
 *
 * У Кармана сутки начинаются в 05:00 МСК: в этот момент утренний обход забирает
 * бонус по всем аккаунтам, и с этого момента очки на них свежие. Значит «сегодня» у
 * владельца — это окно `[D 05:00, D+1 05:00)`, а не календарная дата D.
 *
 * Панель считала по календарной дате (`dailyBonusStats(moscowToday())`), и из-за
 * этого в ночные часы показывала «почти пустой» новый день: между 00:00 и 05:00 МСК
 * календарная дата уже сменилась, а сутки — ещё нет. Владелец цифры не узнавал.
 *
 * ## Что считаем по окну, а что — «на сейчас»
 *
 * - **Поток** (окно): сколько забрали, сколько отдали, сколько забрал потребитель —
 *   по времени события (`claimed_at` / `handed_at`).
 * - **Остаток** (на сейчас, не окно): наши клетки, которые ещё не отдали. Это сток,
 *   а не поток: он копится сутками и в окно не вписывается.
 *
 * ## Почему по времени события, а не по `used_on`
 *
 * `used_on` — московская календарная дата строки леджера. У вендора свои сутки
 * (смена в 21:00 МСК), поэтому забор в 00:00–03:00 МСК попадает в `used_on` следующей
 * календарной даты, хотя по нашим суткам он ещё внутри текущих. По времени события
 * окно всегда сходится само с собой: что забрали в окно — то и отдали в окно.
 *
 * ## Темп
 *
 * Темп — сколько очков мы отдаём за операционные сутки, по срезу последних полных
 * операционных суток. Источник — леджер (`handed_points`), а не журнал активаций:
 * журнал считает момент активации, леджер — момент выдачи, и для вопроса «хватает ли
 * токенов на день» нужен именно расход.
 *
 * **Срез показывает фактические дни с данными**, а не весь окно: леджер живёт с
 * 18.11, и окно «11.11—20.11» на панели выглядело как десять суток среднего,
 * хотя среднее считалось по трём (21.11: 40 533 очк./сутки = 121 600 за 18—20.11).
 *
 * ## Остаток — раздельно «сегодня» и «с прошлых суток» (заказ владельца 21.11)
 *
 * «На аккаунтах 173 200 (141 акк.)» — две разные вещи в одной строке: клетки,
 * забранные СЕГОДНЯ (свежие очки, их ещё можно отдать потребителю), и клетки
 * прошлых суток, которые никто не забрал. Владелец читал это как «осталось
 * сегодня» — и получал число больше дневного забора. Теперь строки две.
 */
export type OperationalBonusStats = {
  /** Начало окна (ISO) — 05:00 МСК. */
  from: string;
  /** Конец окна (ISO) — 05:00 МСК следующих суток. */
  to: string;
  /** Московская дата начала суток ('YYYY-MM-DD'). */
  date: string;
  /** Подпись окна: '20.11 → 21.11'. */
  label: string;
  /** Сколько клеток забрали МЫ за сутки. */
  collected: number;
  /** Сколько очков забрали мы за сутки. */
  collectedPoints: number;
  /** Сколько клеток забрал потребитель (мимо нас — очки ушли ему). */
  consumerTaken: number;
  /** Сколько очков забрал потребитель. */
  consumerTakenPoints: number;
  /** Сколько РАЗНЫХ аккаунтов клетку забрали за сутки (наши и чужие). */
  claimedAccounts: number;
  /** Сколько аккаунтов отдали за сутки. */
  handed: number;
  /** Сколько очков отдали за сутки. */
  handedPoints: number;
  /** Остаток на аккаунтах: наши клетки, которые ещё не отдали (очки). */
  stockPoints: number;
  /** Сколько РАЗНЫХ аккаунтов держат эти клетки. */
  stockAccounts: number;
  /** Сколько клеток (строк леджера) лежит на аккаунтах. */
  stockCells: number;
  /** Сколько тысячных клеток забрали за сутки. */
  thousands: number;
  /** Остаток ТЕКУЩИХ суток: наши клетки, забранные в окне и ещё не отданные. */
  freshPoints: number;
  /** Сколько таких клеток. */
  freshCells: number;
  /** Сколько разных аккаунтов их держат. */
  freshAccounts: number;
  /** Сколько тысячных из них ждут в пуле (их надо отдавать первыми). */
  freshThousands: number;
  /** Сколько очков в этих тысячных. */
  freshThousandsPoints: number;
  /** Остаток ПРОШЛЫХ суток: наши клетки, забранные до окна и не отданные. */
  olderPoints: number;
  /** Сколько таких клеток. */
  olderCells: number;
  /** Текущая клетка вендора по аккаунтам: клетка → сколько аккаунтов. */
  cells: { cell: number; points: number; accounts: number }[];
  /** Сколько серий сгорело: клетка не выросла на 1 за сутки (0 — нить цела). */
  seriesBroken: number;
  /** Темп: очков в сутки по срезу последних полных операционных суток. */
  pointsPerDay: number | null;
  /** Сколько полных суток попало в срез темпа. */
  sliceDays: number;
  /** Начало среза темпа (московская дата начала суток) — первый день с данными. */
  sliceFrom: string;
  /** Конец среза темпа (московская дата начала суток) — последний полный день с данными. */
  sliceTo: string;
  /** Комната-потребитель → очки за сутки. */
  byProject: { project: string; accounts: number; points: number }[];
};

const DAY_MS = 24 * 3_600_000;

/**
 * Сколько суток живёт очко клетки (окно сгорания у вендора).
 *
 * Ответ вендора на забор отдаёт `expire_at_ms`: клетка 18.11 дожила до 17.12 —
 * месяц. Значит «осталось на аккаунтах» — это не одно число, а два: клетки
 * текущих суток (свежие) и клетки прошлых суток (тоже ещё живые, но это уже
 * вчерашний забор).
 */
const CELL_POINTS_LIVE_DAYS = 30;

/** '2026-11-20' → '20.11' (подпись для глаза). */
function shortDay(date: string): string {
  return `${date.slice(8, 10)}.${date.slice(5, 7)}`;
}

export async function operationalBonusStats(
  now: Date = new Date(),
): Promise<OperationalBonusStats> {
  const from = operationalDayStart(now);
  const to = new Date(from.getTime() + DAY_MS);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  // Окно суток по времени события: забор (claimed_at) и выдача (handed_at).
  const claimedInWindow = and(
    gte(accountsDailyBonus.claimedAt, fromIso),
    lt(accountsDailyBonus.claimedAt, toIso),
  );
  const handedInWindow = and(
    gte(accountsDailyBonus.handedAt, fromIso),
    lt(accountsDailyBonus.handedAt, toIso),
  );

  const [
    collected,
    consumer,
    claimedAccounts,
    handed,
    stock,
    thousands,
    projects,
    paceRows,
    cellRows,
  ] = await Promise.all([
    // Забрали мы.
    db
      .select({
        n: sql<number>`count(*)::int`,
        points: sql<number>`coalesce(sum(${accountsDailyBonus.points}), 0)::int`,
      })
      .from(accountsDailyBonus)
      .where(and(eq(accountsDailyBonus.claimResult, CLAIM_RESULT_CLAIMED), claimedInWindow)),
    // Клетку забрал потребитель (обычно ночью) — эти очки ушли мимо нас.
    db
      .select({
        n: sql<number>`count(*)::int`,
        points: sql<number>`coalesce(sum(${accountsDailyBonus.points}), 0)::int`,
      })
      .from(accountsDailyBonus)
      .where(and(ne(accountsDailyBonus.claimResult, CLAIM_RESULT_CLAIMED), claimedInWindow)),
    // Сколько РАЗНЫХ аккаунтов клетку забрали за сутки (наши и чужие): это и есть
    // «сколько аккаунтов обход обошёл».
    db
      .select({ n: sql<number>`count(distinct ${accountsDailyBonus.accountId})::int` })
      .from(accountsDailyBonus)
      .where(claimedInWindow),
    // Отдали за сутки.
    db
      .select({
        n: sql<number>`count(*)::int`,
        points: sql<number>`coalesce(sum(${accountsDailyBonus.handedPoints}), 0)::int`,
      })
      .from(accountsDailyBonus)
      .where(and(isNotNull(accountsDailyBonus.handedAt), handedInWindow)),
    // Остаток на аккаунтах — НА СЕЙЧАС, не за окно. Свежая часть (клетки,
    // забранные в текущих операционных сутках) и старая (за прошлые сутки) —
    // раздельно: «осталось 173 200» без разбора значило две разные вещи.
    db
      .select({
        points: sql<number>`coalesce(sum(${accountsDailyBonus.points}), 0)::int`,
        accounts: sql<number>`count(distinct ${accountsDailyBonus.accountId})::int`,
        cells: sql<number>`count(*)::int`,
        freshPoints: sql<number>`coalesce(sum(${accountsDailyBonus.points}) filter (where ${accountsDailyBonus.claimedAt} >= ${fromIso}), 0)::int`,
        freshCells: sql<number>`count(*) filter (where ${accountsDailyBonus.claimedAt} >= ${fromIso})::int`,
        freshAccounts: sql<number>`count(distinct ${accountsDailyBonus.accountId}) filter (where ${accountsDailyBonus.claimedAt} >= ${fromIso})::int`,
        freshThousands: sql<number>`count(*) filter (where ${accountsDailyBonus.claimedAt} >= ${fromIso} and ${accountsDailyBonus.points} >= 1000)::int`,
        freshThousandsPoints: sql<number>`coalesce(sum(${accountsDailyBonus.points}) filter (where ${accountsDailyBonus.claimedAt} >= ${fromIso} and ${accountsDailyBonus.points} >= 1000), 0)::int`,
        olderPoints: sql<number>`coalesce(sum(${accountsDailyBonus.points}) filter (where ${accountsDailyBonus.claimedAt} < ${fromIso}), 0)::int`,
        olderCells: sql<number>`count(*) filter (where ${accountsDailyBonus.claimedAt} < ${fromIso})::int`,
      })
      .from(accountsDailyBonus)
      .where(
        and(eq(accountsDailyBonus.claimResult, CLAIM_RESULT_CLAIMED), isNull(accountsDailyBonus.handedAt)),
      ),
    // Тысячные клетки за сутки.
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(accountsDailyBonus)
      .where(
        and(
          eq(accountsDailyBonus.claimResult, CLAIM_RESULT_CLAIMED),
          sql`${accountsDailyBonus.points} >= 1000`,
          claimedInWindow,
        ),
      ),
    // Куда ушло по комнатам-потребителям.
    db
      .select({
        projectId: accountsDailyBonus.handedToProjectId,
        projectName: accountsProject.name,
        n: sql<number>`count(*)::int`,
        points: sql<number>`coalesce(sum(${accountsDailyBonus.handedPoints}), 0)::int`,
      })
      .from(accountsDailyBonus)
      .leftJoin(accountsProject, eq(accountsProject.id, accountsDailyBonus.handedToProjectId))
      .where(and(isNotNull(accountsDailyBonus.handedAt), handedInWindow))
      .groupBy(accountsDailyBonus.handedToProjectId, accountsProject.name),
    // Срез темпа: последние полные операционные сутки (текущее окно в срез не входит).
    db
      .select({
        handedAt: accountsDailyBonus.handedAt,
        points: accountsDailyBonus.handedPoints,
      })
      .from(accountsDailyBonus)
      .where(
        and(
          isNotNull(accountsDailyBonus.handedAt),
          gte(
            accountsDailyBonus.handedAt,
            new Date(from.getTime() - PACE_WINDOW_DAYS * DAY_MS).toISOString(),
          ),
          lt(accountsDailyBonus.handedAt, fromIso),
        ),
      ),
    // Клетки вендора по аккаунтам — последний забор каждого (текущая клетка) и
    // проверка, что нить не рвалась. Живёт столько же, сколько живут очки клетки.
    db
      .select({
        accountId: accountsDailyBonus.accountId,
        dayNo: accountsDailyBonus.dayNo,
        points: accountsDailyBonus.points,
        claimedAt: accountsDailyBonus.claimedAt,
      })
      .from(accountsDailyBonus)
      .where(
        gte(
          accountsDailyBonus.claimedAt,
          new Date(from.getTime() - CELL_POINTS_LIVE_DAYS * DAY_MS).toISOString(),
        ),
      )
      .orderBy(accountsDailyBonus.accountId, accountsDailyBonus.claimedAt),
  ]);

  // Темп: сутки без выдач НЕ считаем (нулевой расход ≠ отсутствие спроса).
  const sliceStart = from.getTime() - PACE_WINDOW_DAYS * DAY_MS;
  const byDay = new Map<number, number>();
  for (const row of paceRows) {
    if (!row.handedAt) continue;
    const index = Math.floor((new Date(row.handedAt).getTime() - sliceStart) / DAY_MS);
    byDay.set(index, (byDay.get(index) ?? 0) + (row.points ?? 0));
  }
  let slicePoints = 0;
  for (const points of byDay.values()) slicePoints += points;
  const sliceDays = byDay.size;
  // Срез показывает ФАКТИЧЕСКИЕ дни с данными: леджер живёт не с начала окна,
  // и «11.11—20.11» на панели выглядело как десять суток среднего, хотя среднее
  // считалось по трём.
  const dayIndexes = [...byDay.keys()].sort((a, b) => a - b);
  const firstDay = dayIndexes[0] ?? 0;
  const lastDay = dayIndexes[dayIndexes.length - 1] ?? 0;

  // Текущая клетка вендора по каждому аккаунту (последний забор) и проверка
  // нити: клетка растёт на 1 за сутки, пока серия не сгорела.
  const currentCell = new Map<number, { cell: number; points: number }>();
  const lastCell = new Map<number, number>();
  let seriesBroken = 0;
  const broken = new Set<number>();
  for (const row of cellRows) {
    if (row.dayNo <= 0) continue;
    const previous = lastCell.get(row.accountId);
    if (previous !== undefined && row.dayNo !== (previous % 7) + 1) broken.add(row.accountId);
    lastCell.set(row.accountId, row.dayNo);
    currentCell.set(row.accountId, { cell: row.dayNo, points: row.points });
  }
  seriesBroken = broken.size;
  const cellMap = new Map<number, { cell: number; points: number; accounts: number }>();
  for (const { cell, points } of currentCell.values()) {
    const item = cellMap.get(cell) ?? { cell, points, accounts: 0 };
    item.accounts += 1;
    cellMap.set(cell, item);
  }
  const cells = [...cellMap.values()].sort((a, b) => a.cell - b.cell);

  const date = moscowToday(from);
  const toDate = moscowToday(to);

  return {
    from: fromIso,
    to: toIso,
    date,
    label: `${shortDay(date)} → ${shortDay(toDate)}`,
    collected: collected[0]?.n ?? 0,
    collectedPoints: collected[0]?.points ?? 0,
    consumerTaken: consumer[0]?.n ?? 0,
    consumerTakenPoints: consumer[0]?.points ?? 0,
    claimedAccounts: claimedAccounts[0]?.n ?? 0,
    handed: handed[0]?.n ?? 0,
    handedPoints: handed[0]?.points ?? 0,
    stockPoints: stock[0]?.points ?? 0,
    stockAccounts: stock[0]?.accounts ?? 0,
    stockCells: stock[0]?.cells ?? 0,
    thousands: thousands[0]?.n ?? 0,
    freshPoints: stock[0]?.freshPoints ?? 0,
    freshCells: stock[0]?.freshCells ?? 0,
    freshAccounts: stock[0]?.freshAccounts ?? 0,
    freshThousands: stock[0]?.freshThousands ?? 0,
    freshThousandsPoints: stock[0]?.freshThousandsPoints ?? 0,
    olderPoints: stock[0]?.olderPoints ?? 0,
    olderCells: stock[0]?.olderCells ?? 0,
    cells,
    seriesBroken,
    pointsPerDay: sliceDays > 0 ? slicePoints / sliceDays : null,
    sliceDays,
    sliceFrom: moscowToday(new Date(sliceStart + firstDay * DAY_MS)),
    sliceTo: moscowToday(new Date(sliceStart + lastDay * DAY_MS)),
    byProject: projects
      .map((row) => ({
        project: row.projectId === null ? '(без комнаты)' : (row.projectName ?? '—'),
        accounts: row.n,
        points: row.points,
      }))
      .sort((a, b) => b.points - a.points),
  };
}
