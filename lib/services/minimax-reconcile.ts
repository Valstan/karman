import 'server-only';
import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { accountsAccount, accountsDailyBonus, accountsUsage } from '@/lib/db/schema';
import { moscowToday } from '@/lib/accounts/rotation';
import { CLAIM_RESULT_ALREADY, CLAIM_RESULT_CLAIMED } from '@/lib/minimax/claim';

/**
 * Пауза перед проверкой выдачи (мс) — мадат владельца 18.11, 21:40 МСК:
 * «последние полчаса не трогать, то что там выдали, возможно ещё в работе и проверять
 * его ещё рано».
 *
 * Значит сторож смотрит только выдачи, которым уже не меньше получаса: у них потребитель
 * либо закончил, либо застрял — и возвращать аккаунт в оборот уже можно.
 */
export const MIN_HANDOUT_AGE_MS = 30 * 60_000;

/**
 * Сверка журнала активаций с панелью MiniMax (заказ владельца 17.11).
 *
 * ## Что чинит
 *
 * **Запись активации пишется в момент ВЫДАЧИ аккаунта**, а очки потребитель забирает
 * позже (когда его рантайм реально стартует под аккаунтом). Между выдачей и забором
 * проходит время, и всё это время журнал считает аккаунт израсходованным.
 *
 * Живой разбор 17.11: в журнале за день стояло 111 активаций / 47 400 очков (brain —
 * 108), а панель MiniMax — источник правды — сказала, что очки сожжены только у 53
 * аккаунтов (24 200 очков). У 58 аккаунтов сегодняшняя клетка панели оставалась
 * «можно забрать» — то есть очки у них целы, а расход в журнале был фантомным. По
 * согласию владельца эти 58 вернули в оборот (см. `docs/notes/minimax-17.11-release.md`).
 *
 * ## Что делает модуль
 *
 * 1. **Освобождает ошибочно погашенные.** Строка журнала за сегодня удаляется, у
 *    аккаунта снимается отметка дня — он снова свободен, с настоящими очками.
 * 2. **Поправляет статистику предсказаний.** У строк, которые действительно израсходованы,
 *    номер клетки и очки берутся **из панели** (а не из нашей модели по датам): модель
 *    разошлась с панелью у 42 аккаунтов из 112 (живая сверка 16.11), и её тянуло
 *    фантомными записями. После сверки журнал совпадает с панелью, а серия дней
 *    подряд (из которой модель считает следующую клетку) перестаёт раздуваться
 *    фантомными днями.
 *
 * ## Почему по двум поясам
 *
 * Сутки MiniMax считаются по часовому поясу ЗАПРОСА. В ночном окне 00:00–03:00 МСК
 * «сегодня» панели потребителя (UTC) — это вчерашний день московской даты, и забор
 * очков там засчитывается за ДРУГОЙ день. Поэтому решение принимается только если
 * **оба** ответа панели говорят одно и то же:
 *
 * - оба «очки есть» → сегодняшний забор не состоялся → строка фантомная → освобождаем;
 * - оба «очки сожжены» → забор состоялся → уточняем клетку и очки по панели;
 * - ответы расходятся или протухли → **не трогаем** (это «не знаю», а не «очков нет»).
 *
 * Свежесть состояния — часть правды: протухший ответ панели означает «не знаю».
 *
 * ## Сколько это стоит
 *
 * Обращений к вендору сверка НЕ делает: она работает по ответам панели, которые уже
 * прочитала автосверка (`sweepPanelStates`, раз в 15 минут). Здесь только работа с БД.
 */
export type ReconcileVerdict = 'release' | 'correct' | 'spent' | 'skip';

export type ReconcileReport = {
  /** Московская дата, которую сверяли. */
  today: string;
  /** Строк журнала за сегодня, попавших в окно проверки. */
  rows: number;
  /** Освобождено (фантомных записей). */
  released: number;
  /** Уточнено по панели (клетка и очки). */
  corrected: number;
  /** Занесены в список погашенных на сегодня (очки забрал потребитель). */
  spent: number;
  /** Не тронуто: панель не ответила, ответ протух или пояса расходятся. */
  skipped: number;
  /** Очки, снятые с фантомных записей. */
  releasedPoints: number;
  /** Очки, уточнённые по панели. */
  correctedPoints: number;
  releasedIds: number[];
  correctedIds: number[];
  /** Занесены в список погашенных на сегодня (очки забрал потребитель). */
  spentIds: number[];
  /**
   * Курсор для следующего прохода: время последней ВЫДАЧИ, которую мы проверили
   * (ISO). Сторож идёт по дереву выдачи вверх по времени — от курсора к новым
   * выдачам (мадат владельца 18.11, 21:40 МСК).
   */
  cursor: string | null;
};

/**
 * Вердикт по одной строке журнала — чистое решение (без БД), чтобы правило
 * можно было проверить юнитом.
 *
 * **Опирается только на наш леджер забора.** Панель остатка очков не отдаёт
 * (`points` клетки — её номинал, а не «сколько осталось»; живая проверка
 * 18.11), и ходить к вендору за «остатком» бессмысленно. Признак один:
 * `claim_result` из ответа на забор.
 *
 * - `claimResult = null` — забора сегодня не было: очки ещё появятся, до утра их не
 *   трогаем;
 * - `remaining = 0` — уже признан пустым на сегодня: повторно не проверяем (до 05:00
 *   следующего дня по Москве);
 * - `claimResult = 1` — клетку забрали МЫ: очки наши → аккаунт возвращается в оборот;
 * - `claimResult = 2` — клетку забрал ПОТРЕБИТЕЛЬ: очки у него и потрачены → в список
 *   погашенных на сегодня.
 */
export function reconcileVerdict(
  claimResult: number | null,
  remaining: number | null,
): { verdict: ReconcileVerdict; cell: number | null; points: number | null } {
  const none = { verdict: 'skip' as const, cell: null, points: null };
  // Забора сегодня не было: очки ещё появятся, до утра не трогаем.
  if (claimResult === null) return none;
  // Забрал ПОТРЕБИТЕЛЬ → очки у него и потрачены. Если он уже помечен пустым
  // (остаток = 0) — это повторная проверка, не трогаем (до 05:00 следующего дня).
  if (claimResult === CLAIM_RESULT_ALREADY) {
    if (remaining === 0) return none;
    return { verdict: 'spent', cell: null, points: null };
  }
  // Забрали МЫ → очки наши: аккаунт возвращается в оборот.
  if (claimResult === CLAIM_RESULT_CLAIMED) {
    if (remaining === 0) return none;
    return { verdict: 'release', cell: null, points: null };
  }
  return none;
}
export async function reconcileActivations(
  now: Date = new Date(),
  options: { userId?: number; cursor?: string | null; minHandoutAgeMs?: number } = {},
): Promise<ReconcileReport> {
  const today = moscowToday(now);
  const report: ReconcileReport = {
    today,
    rows: 0,
    released: 0,
    corrected: 0,
    /** Занесены в список погашенных на сегодня (очки забрал потребитель). */
    spent: 0,
    skipped: 0,
    releasedPoints: 0,
    correctedPoints: 0,
    releasedIds: [],
    correctedIds: [],
    spentIds: [],
    cursor: options.cursor ?? null,
  };

  // ОКНО ПРОВЕРКИ (мадат владельца 18.11, 21:40 МСК). Сторож идёт по дереву выдачи
  // вверх по времени: от того, что уже проверил (курсор), к новым выдачам — но
  // только к тем, которым уже не меньше получаса: «последние полчаса не трогать, то
  // что там выдали, возможно ещё в работе и проверять его ещё рано».
  const minAge = options.minHandoutAgeMs ?? MIN_HANDOUT_AGE_MS;
  // Время в базе — строка ISO (`tstz` в этой схеме строковый), сравниваем строки.
  const cutoff = new Date(now.getTime() - minAge).toISOString();
  const cursor = options.cursor ? new Date(options.cursor).toISOString() : null;

  const rows = await db
    .select({
      id: accountsUsage.id,
      accountId: accountsUsage.accountId,
      userId: accountsUsage.userId,
      tokens: accountsUsage.tokens,
      activationIndex: accountsUsage.activationIndex,
      // Время выдачи: журнал хранит его с момента создания строки — это и есть
      // «дерево выдачи», по которому сторож идёт вверх по времени.
      handedAt: accountsUsage.createdAt,
    })
    .from(accountsUsage)
    .where(
      and(
        eq(accountsUsage.usedOn, today),
        lt(accountsUsage.createdAt, cutoff),
        cursor ? gt(accountsUsage.createdAt, cursor) : undefined,
      ),
    )
    .orderBy(accountsUsage.createdAt);
  report.rows = rows.length;
  if (rows.length === 0) return report;

  const owners = [...new Set(rows.map((row) => row.userId))].filter(
    (userId) => options.userId === undefined || userId === options.userId,
  );

  const releaseIds: number[] = [];
  const spentIds: number[] = [];
  const corrections = new Map<number, { cell: number; points: number }>();
  let releasedPoints = 0;

  // Кто забрал клетку сегодня (из леджера забора): 1 — мы, 2 — потребитель.
  // Это единственный верный признак «чьи очки лежат на аккаунте»: панель остатка
  // очков не отдаёт (её `points` — номинал клетки, живая проверка 18.11).
  const ledgerRows = await db
    .select({
      accountId: accountsDailyBonus.accountId,
      remaining: accountsDailyBonus.remaining,
      claimResult: accountsDailyBonus.claimResult,
      dayNo: accountsDailyBonus.dayNo,
      points: accountsDailyBonus.points,
    })
    .from(accountsDailyBonus)
    .where(eq(accountsDailyBonus.usedOn, today));
  const ledgerByAccount = new Map(ledgerRows.map((r) => [r.accountId, r]));

  for (const userId of owners) {
    for (const row of rows) {
      if (row.userId !== userId) continue;
      const ledger = ledgerByAccount.get(row.accountId) ?? null;
      const verdict = reconcileVerdict(
        ledger?.claimResult ?? null,
        ledger?.remaining ?? null,
      );
      if (verdict.verdict === 'release') {
        releaseIds.push(row.accountId);
        releasedPoints += row.tokens;
      } else if (verdict.verdict === 'spent') {
        // Очки забрал потребитель — они потрачены: в список погашенных на сегодня
        // (до утра не проверяем и в оборот не возвращаем). Клетку и очки журнала
        // уточняем по леджеру — там ответ вендора на забор.
        spentIds.push(row.accountId);
        if (ledger && ledger.dayNo > 0) {
          corrections.set(row.accountId, { cell: ledger.dayNo, points: ledger.points });
        }
      }
    }
  }

  report.skipped = report.rows - releaseIds.length - spentIds.length;

  // Курсор для следующего прохода: время самой поздней ВЫДАЧИ, которую мы посмотрели
  // (не время проверки!). Сторож идёт по дереву выдачи вверх по времени — от этого
  // момента к новым выдачам (мадат владельца 18.11, 21:40 МСК).
  //
  // Считаем ДО раннего выхода: даже когда вердиктов нет (всё уже помечено пустыми),
  // курсор должен двигаться — иначе сторож повторял бы один и тот же кусок дня.
  let latestMs: number | null = null;
  for (const row of rows) {
    const ms = new Date(row.handedAt).getTime();
    if (Number.isNaN(ms)) continue;
    if (latestMs === null || ms > latestMs) latestMs = ms;
  }
  if (latestMs !== null) report.cursor = new Date(latestMs).toISOString();

  if (releaseIds.length === 0 && spentIds.length === 0) return report;

  // Очки последней НАСТОЯЩЕЙ активации (до сегодняшней) — их вернём в строку аккаунта,
  // чтобы «последние очки» не показывали фантомные.
  const previousTokens = new Map<number, number>();
  if (releaseIds.length > 0) {
    const previous = await db
      .select({ accountId: accountsUsage.accountId, tokens: accountsUsage.tokens })
      .from(accountsUsage)
      .where(and(inArray(accountsUsage.accountId, releaseIds), lt(accountsUsage.usedOn, today)));
    for (const row of previous) {
      const known = previousTokens.get(row.accountId);
      if (known === undefined) previousTokens.set(row.accountId, row.tokens);
    }
  }

  await db.transaction(async (tx) => {
    if (releaseIds.length > 0) {
      // ЗАПИСЬ ВЫДАЧИ ОСТАЁТСЯ (мадат владельца 18.11, 21:40 МСК: «вести статистику
      // аккаунтов, которые были выданы, точки времени»). Раньше строку журнала удаляли —
      // и вместе с ней терялась и статистика («кому и сколько очков отдали»), и сам
      // след выдачи, по которому сторож идёт вверх по времени.
      //
      // Освобождается только СЕССИЯ аккаунта (отметка «начало использования») — она и
      // держала аккаунт в работе. Отметка отдачи в леджере остаётся: это запись «кому
      // и когда отдали», и она же объясняет, почему аккаунт был занят.
      for (const accountId of releaseIds) {
        await tx
          .update(accountsAccount)
          .set({
            usedOn: null,
            usedAt: null,
            lastTokens: previousTokens.get(accountId) ?? 0,
            updatedAt: now.toISOString(),
          })
          .where(eq(accountsAccount.id, accountId));
      }
    }
    // Список погашенных на сегодня: очки забрал потребитель (остаток = 0).
    // До утра следующего дня такие аккаунты сторож не перепроверяет и в оборот
    // не возвращает.
    if (spentIds.length > 0) {
      await tx
        .update(accountsDailyBonus)
        .set({ remaining: 0, checkedAt: now.toISOString() })
        .where(
          and(
            inArray(accountsDailyBonus.accountId, spentIds),
            eq(accountsDailyBonus.usedOn, today),
          ),
        );
    }
    for (const [accountId, fix] of corrections) {
      await tx
        .update(accountsUsage)
        .set({ activationIndex: fix.cell, tokens: fix.points })
        .where(and(eq(accountsUsage.accountId, accountId), eq(accountsUsage.usedOn, today)));
      await tx
        .update(accountsAccount)
        .set({ lastTokens: fix.points, updatedAt: now.toISOString() })
        .where(eq(accountsAccount.id, accountId));
    }
  });

  report.released = releaseIds.length;
  report.corrected = corrections.size;
  report.spent = spentIds.length;
  report.releasedPoints = releasedPoints;
  report.correctedPoints = [...corrections.values()].reduce((sum, fix) => sum + fix.points, 0);
  report.releasedIds = releaseIds;
  report.correctedIds = [...corrections.keys()];
  report.spentIds = spentIds;
  return report;
}
