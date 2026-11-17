import 'server-only';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { accountsAccount, accountsUsage } from '@/lib/db/schema';
import { moscowToday } from '@/lib/accounts/rotation';
import { pointsForIndex } from '@/lib/accounts/weekly';
import {
  DEFAULT_TIMEZONE,
  OWNER_TIMEZONE,
  PANEL_STATUS_CLAIMABLE,
  PANEL_STATUS_CLAIMED,
} from '@/lib/minimax/panel';
import { isFreshPanelState, readPanelStates, type PanelState } from '@/lib/accounts/panel-state';

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
export type ReconcileVerdict = 'release' | 'correct' | 'skip';

export type ReconcileReport = {
  /** Московская дата, которую сверяли. */
  today: string;
  /** Строк журнала за сегодня. */
  rows: number;
  /** Освобождено (фантомных записей). */
  released: number;
  /** Уточнено по панели (клетка и очки). */
  corrected: number;
  /** Не тронуто: панель не ответила, ответ протух или пояса расходятся. */
  skipped: number;
  /** Очки, снятые с фантомных записей. */
  releasedPoints: number;
  /** Очки, уточнённые по панели. */
  correctedPoints: number;
  releasedIds: number[];
  correctedIds: number[];
};

/**
 * Вердикт по одной строке журнала — чистая функция (без БД), чтобы правило
 * можно было проверить юнитом.
 */
export function reconcileVerdict(
  owner: PanelState | null | undefined,
  consumer: PanelState | null | undefined,
  now: Date = new Date(),
): { verdict: ReconcileVerdict; cell: number | null; points: number | null } {
  const none = { verdict: 'skip' as const, cell: null, points: null };
  if (!owner || !consumer) return none;
  // Протухший ответ панели — это «не знаю», а не «очков нет».
  if (!isFreshPanelState(owner, now) || !isFreshPanelState(consumer, now)) return none;

  if (owner.status === PANEL_STATUS_CLAIMABLE && consumer.status === PANEL_STATUS_CLAIMABLE) {
    return { verdict: 'release', cell: null, points: null };
  }
  if (owner.status === PANEL_STATUS_CLAIMED && consumer.status === PANEL_STATUS_CLAIMED) {
    const cell = owner.cell_no;
    if (!Number.isInteger(cell) || cell < 1 || cell > 7) return none;
    return { verdict: 'correct', cell, points: pointsForIndex(cell) };
  }
  return none;
}

/**
 * Сверить журнал активаций за сегодня с панелью и привести записи в соответствие.
 *
 * @param now   текущий момент (всё считается по московской дате).
 * @param options.userId ограничить сверку владельцем (по умолчанию — все).
 */
export async function reconcileActivations(
  now: Date = new Date(),
  options: { userId?: number } = {},
): Promise<ReconcileReport> {
  const today = moscowToday(now);
  const report: ReconcileReport = {
    today,
    rows: 0,
    released: 0,
    corrected: 0,
    skipped: 0,
    releasedPoints: 0,
    correctedPoints: 0,
    releasedIds: [],
    correctedIds: [],
  };

  const rows = await db
    .select({
      id: accountsUsage.id,
      accountId: accountsUsage.accountId,
      userId: accountsUsage.userId,
      tokens: accountsUsage.tokens,
      activationIndex: accountsUsage.activationIndex,
    })
    .from(accountsUsage)
    .where(eq(accountsUsage.usedOn, today));
  report.rows = rows.length;
  if (rows.length === 0) return report;

  const owners = [...new Set(rows.map((row) => row.userId))].filter(
    (userId) => options.userId === undefined || userId === options.userId,
  );
  const accountIds = [...new Set(rows.map((row) => row.accountId))];

  const releaseIds: number[] = [];
  const corrections = new Map<number, { cell: number; points: number }>();
  let releasedPoints = 0;

  for (const userId of owners) {
    const ownerStates = await readPanelStates(userId, OWNER_TIMEZONE, accountIds);
    const consumerStates = await readPanelStates(userId, DEFAULT_TIMEZONE, accountIds);
    for (const row of rows) {
      if (row.userId !== userId) continue;
      const verdict = reconcileVerdict(
        ownerStates.get(row.accountId),
        consumerStates.get(row.accountId),
        now,
      );
      if (verdict.verdict === 'release') {
        releaseIds.push(row.accountId);
        releasedPoints += row.tokens;
      } else if (verdict.verdict === 'correct' && verdict.cell !== null) {
        corrections.set(row.accountId, { cell: verdict.cell, points: verdict.points ?? 0 });
      }
    }
  }

  report.skipped = report.rows - releaseIds.length - corrections.size;

  if (releaseIds.length === 0 && corrections.size === 0) return report;

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
      await tx
        .delete(accountsUsage)
        .where(and(inArray(accountsUsage.accountId, releaseIds), eq(accountsUsage.usedOn, today)));
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
  report.releasedPoints = releasedPoints;
  report.correctedPoints = [...corrections.values()].reduce((sum, fix) => sum + fix.points, 0);
  report.releasedIds = releaseIds;
  report.correctedIds = [...corrections.keys()];
  return report;
}
