import 'server-only';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { accountsAccount, accountsDailyBonus, accountsProject } from '@/lib/db/schema';
import { moscowToday } from '@/lib/accounts/rotation';
import { OWNER_TIMEZONE } from '@/lib/minimax/panel';
import {
  CLAIM_RESULT_ALREADY,
  CLAIM_RESULT_CLAIMED,
  claimDailyBonus,
} from '@/lib/minimax/claim';
import { liveAccessToken } from './account-tokens';

/**
 * Ежесуточный забор бонусов MiniMax (заказ владельца 18.11).
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
 * 3. **Раздача.** Выдача аккаунта берёт из леджера РЕАЛЬНЫЕ очки этого аккаунта (а не
 *    прогноз модели) и записывает, кому и сколько отдала.
 * 4. **Статистика.** За сутки: сколько бонусов забрали, сколько очков в банке, сколько
 *    отдали, сколько фактически потрачено, сколько осталось неиспользованным.
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
      // Остаток по нашим данным: сколько очков сегодня лежит на аккаунте.
      //   номинал — забрали МЫ: очки наши и свежие;
      //   null   — забрал ПОТРЕБИТЕЛЬ: очки у него и потрачены. Сторож при этом
      //           помечает аккаунт пустым (остаток = 0) — и до 05:00 следующего дня
      //           не перепроверяет его.
      remaining: claim_result === CLAIM_RESULT_CLAIMED ? (points ?? today?.points ?? 0) : null,
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
  }

  return report;
}

/** Записать (или обновить) строку леджера за сутки. */
async function writeBonusRow(row: {
  userId: number;
  accountId: number;
  date: string;
  dayNo: number;
  points: number;
  remaining: number | null;
  status: number;
  claimResult: number;
  claimId: string | null;
  expireAt: string | null;
  now: Date;
}): Promise<void> {
  await db
    .insert(accountsDailyBonus)
    .values({
      userId: row.userId,
      accountId: row.accountId,
      usedOn: row.date,
      dayNo: row.dayNo,
      points: row.points,
      // Остаток по нашим данным: сколько очков сегодня лежит на аккаунте.
      //   номинал — забрали МЫ: очки наши и свежие;
      //   null   — забрал ПОТРЕБИТЕЛЬ: очки у него и потрачены. Сторож при этом
      //           помечает аккаунт пустым (остаток = 0) — и до 05:00 следующего дня
      //           не перепроверяет его.
      remaining: row.claimResult === CLAIM_RESULT_CLAIMED ? row.points : null,
      status: row.status,
      claimResult: row.claimResult,
      claimId: row.claimId,
      expireAt: row.expireAt,
      claimedAt: row.now.toISOString(),
      checkedAt: row.now.toISOString(),
    })
    .onConflictDoUpdate({
      target: [accountsDailyBonus.accountId, accountsDailyBonus.usedOn],
      set: {
        dayNo: row.dayNo,
        points: row.points,
        // Остаток обновляем по ПРАВИЛУ, а не «как в этом прогоне»:
        //   клетку забрали МЫ (claim_result = 1) → остаток = номинал клетки (очки
        //     наши; повторный забор возвращает 2, и без этого оговорка они бы
        //     обнулились и аккаунт выпал бы из выдачи);
        //   иначе → сохраняем то, что помечено сторожем (0 = «проверено, пусто»).
        remaining: sql`case when ${accountsDailyBonus.claimResult} = ${CLAIM_RESULT_CLAIMED}::smallint then ${row.points}::integer else coalesce(${accountsDailyBonus.remaining}, ${row.remaining}::integer) end`,
        status: row.status,
        // Результат забора НЕ понижаем. 1 («забрали мы») — это навсегда наша
        // сегодняшняя клетка: очки свежие, их можно отдавать. Повторный забор в те
        // же сутки (обход идёт и по рестарту воркера — 18.11) возвращает 2, и без
        // этой оговорки «наши» очки терялись бы, а в выдачу попадали бы аккаунты с
        // давно потраченными очками (жалоба владельца 18.11).
        claimResult: sql`case when ${accountsDailyBonus.claimResult} = ${CLAIM_RESULT_CLAIMED}::smallint then ${CLAIM_RESULT_CLAIMED}::smallint else ${row.claimResult}::smallint end`,
        // Идентификатор забора — тот же: он принадлежит НАШЕМУ забору.
        claimId: sql`case when ${accountsDailyBonus.claimResult} = ${CLAIM_RESULT_CLAIMED} then ${accountsDailyBonus.claimId} else ${row.claimId} end`,
        expireAt: row.expireAt,
        checkedAt: row.now.toISOString(),
      },
    });
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
 */
export async function markBonusHanded(
  accountId: number,
  date: string,
  projectId: number | null,
  points: number | null,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(accountsDailyBonus)
    .set({
      handedToProjectId: projectId,
      handedAt: now.toISOString(),
      handedPoints: points,
      // Остаток НЕ трогаем: это «сколько очков лежит по нашим данным», а не
      // «сколько отдали». Помечать аккаунт пустым (остаток = 0) — дело сторожа.
    })
    .where(
      and(
        eq(accountsDailyBonus.accountId, accountId),
        eq(accountsDailyBonus.usedOn, date),
      ),
    );
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
