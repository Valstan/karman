import 'server-only';
import { and, desc, eq, gte, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  accountsAccount,
  accountsDailyBonus,
  accountsUsage,
  secretsAudit,
  secretsProject,
} from '@/lib/db/schema';
import { moscowToday, operationalDayStart } from '@/lib/accounts/rotation';
import { CLAIM_RESULT_CLAIMED } from '@/lib/minimax/claim';
import { parseIssueDetail, type TrafficIssue, type TrafficStats } from '@/lib/accounts/traffic';
import { ownership, type SessionUser } from '@/lib/auth/rbac';

/**
 * Данные блока «Текучка» (заказ владельца 23.11).
 *
 * ## Откуда что берётся
 *
 * | Вопрос | Источник |
 * |---|---|
 * | сколько аккаунтов в системе | список аккаунтов владельца (`accounts_account`) — его уже грузит страница |
 * | сколько потрачено сегодня | леджер бонусов (`accounts_daily_bonus`) + журнал активаций (`accounts_usage`) |
 * | сколько осталось | список аккаунтов: готовы к выдаче и с целыми очками (`lib/accounts/traffic.ts`) |
 * | последние 10 выдач | аудит комнат (`secrets_audit`, действие `minimax_account_issued`) |
 *
 * **Аудит, а не новый счётчик.** Прямо так и просил заказ: «используй существующий
 * аудит, а не заводи новый счётчик». В строке аудита выдачи есть всё нужное:
 * комната (структурно — `project_id` → `secrets_project.slug`), проект и область
 * потребителя (в тексте подробности) и очки, которые нёс аккаунт в момент
 * выдачи (тоже в тексте: «очки 1000» — это номинал клетки по ответу вендора на
 * забор, сделанный в момент выдачи).
 *
 * ## Окно «сегодня»
 *
 * Операционные сутки 05:00 → 05:00 МСК — тот же контур, что у блока
 * «Пул и бонусы» (`operationalBonusStats`). По времени события, а не по
 * московской дате строки: вендорские сутки и наши — разные календари, и забор
 * в 00:00–03:00 МСК попадает в `used_on` следующей даты, хотя по нашим суткам
 * он ещё внутри текущих.
 *
 * ## Почему «потрачено» собирается из трёх групп
 *
 * 1. **Отдали** (леджер, `handed_at` в окне) — мы отдали аккаунт потребителю или
 *    владельцу. Сюда попадают и выдачи комнатам, и владельцу через кнопку
 *    «Выдать аккаунт».
 * 2. **Клетку забрал потребитель** (леджер, `claim_result ≠ 1` и `claimed_at` в
 *    окне) — очки сгорели у потребителя, мимо нас.
 * 3. **Вручную** (журнал активаций, `created_at` в окне) — ручная активация
 *    владельцем кнопкой «Активировать»: в журнал пишется, а в леджер — нет.
 *
 * Группы могут пересекаться (одна и та же выдача стоит и в леджере, и в
 * журнале), поэтому счёт — по РАЗНЫМ аккаунтам, объединением множеств: один
 * аккаунт не может попасть в «потрачено» дважды.
 */

const DAY_MS = 24 * 3_600_000;

/** Сколько выдач показываем в списке «последние 10». */
const RECENT_LIMIT = 10;

/** '2026-11-20' → '20.11' (подпись для глаза). */
function shortDay(date: string): string {
  return `${date.slice(8, 10)}.${date.slice(5, 7)}`;
}

/**
 * Метка времени Postgres ('2026-11-19 07:00:00+00') → ISO.
 *
 * Колонки `timestamptz` в схеме объявлены строкой (`mode: 'string'`), и Postgres
 * отдаёт их в своём формате. Он разбирается `new Date`, но наружу отдаём ISO —
 * чтобы сортировка строк по времени была честной, а не «как получилось».
 */
function isoTime(value: string): string {
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return value;
  return new Date(ms).toISOString();
}

/**
 * Свод блока «Текучка» на текущие операционные сутки.
 *
 * «Всего в системе» считается здесь же: тот же фильтр по владельцу, что у
 * списка аккаунтов на странице, — значит числа не могут разойтись.
 */
export async function trafficStats(
  user: SessionUser,
  now: Date = new Date(),
): Promise<TrafficStats> {
  const from = operationalDayStart(now);
  const to = new Date(from.getTime() + DAY_MS);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const [totalRows, handedRows, consumerRows, journalRows, auditRows, ownerRows] =
    await Promise.all([
      // Всего аккаунтов в системе: пул целиком, а не только выданные.
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(accountsAccount)
        .where(ownership(user, accountsAccount.userId)),
      // Отдали: очки ушли с аккаунтом.
      db
        .select({
          accountId: accountsDailyBonus.accountId,
          points: accountsDailyBonus.handedPoints,
        })
        .from(accountsDailyBonus)
        .where(
          and(
            isNotNull(accountsDailyBonus.handedAt),
            gte(accountsDailyBonus.handedAt, fromIso),
            lt(accountsDailyBonus.handedAt, toIso),
          ),
        ),
      // Клетку забрал потребитель — очки сгорели у него, мимо нас.
      db
        .select({ accountId: accountsDailyBonus.accountId })
        .from(accountsDailyBonus)
        .where(
          and(
            ne(accountsDailyBonus.claimResult, CLAIM_RESULT_CLAIMED),
            gte(accountsDailyBonus.claimedAt, fromIso),
            lt(accountsDailyBonus.claimedAt, toIso),
          ),
        ),
      // Журнал активаций: ловит ручную активацию владельцем (в леджере её нет).
      db
        .select({ accountId: accountsUsage.accountId })
        .from(accountsUsage)
        .where(
          and(
            gte(accountsUsage.createdAt, fromIso),
            lt(accountsUsage.createdAt, toIso),
          ),
        ),
      // Последние выдачи комнат — из аудита.
      db
        .select({
          at: secretsAudit.at,
          detail: secretsAudit.detail,
          room: secretsProject.slug,
        })
        .from(secretsAudit)
        .leftJoin(secretsProject, eq(secretsAudit.projectId, secretsProject.id))
        .where(eq(secretsAudit.action, 'minimax_account_issued'))
        .orderBy(desc(secretsAudit.at))
        .limit(RECENT_LIMIT),
      // Выдачи владельца (кнопка «Выдать аккаунт»): в аудите их нет — там только
      // комнаты, — но в леджере они помечены пустым проектом.
      db
        .select({
          at: accountsDailyBonus.handedAt,
          accountId: accountsDailyBonus.accountId,
          points: accountsDailyBonus.handedPoints,
          title: accountsAccount.title,
        })
        .from(accountsDailyBonus)
        .leftJoin(accountsAccount, eq(accountsAccount.id, accountsDailyBonus.accountId))
        .where(
          and(
            isNotNull(accountsDailyBonus.handedAt),
            isNull(accountsDailyBonus.handedToProjectId),
          ),
        )
        .orderBy(desc(accountsDailyBonus.handedAt))
        .limit(RECENT_LIMIT),
    ]);

  // Счёт по РАЗНЫМ аккаунтам: группы пересекаются, а аккаунт потрачен один раз.
  const handedIds = new Set(handedRows.map((row) => row.accountId));
  const consumerIds = new Set<number>();
  for (const row of consumerRows) {
    if (!handedIds.has(row.accountId)) consumerIds.add(row.accountId);
  }
  const manualIds = new Set<number>();
  for (const row of journalRows) {
    if (handedIds.has(row.accountId)) continue;
    if (consumerIds.has(row.accountId)) continue;
    manualIds.add(row.accountId);
  }

  const handedPoints = handedRows.reduce((total, row) => total + (row.points ?? 0), 0);

  // Последние 10 выдач: комнаты (аудит) + выдачи владельца (леджер), свежие сверху.
  const recent: TrafficIssue[] = [
    ...auditRows.map((row) => {
      const detail = parseIssueDetail(row.detail);
      return {
        at: isoTime(row.at),
        accountId: detail.accountId,
        title: detail.title,
        room: row.room,
        project: detail.project,
        area: detail.area,
        points: detail.points,
        owner: false,
      } satisfies TrafficIssue;
    }),
    ...ownerRows.map((row) => ({
      at: row.at ? isoTime(row.at) : '',
      accountId: row.accountId,
      title: row.title,
      room: null,
      project: null,
      area: null,
      points: row.points,
      owner: true,
    } satisfies TrafficIssue)),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, RECENT_LIMIT);

  return {
    label: `${shortDay(moscowToday(from))} → ${shortDay(moscowToday(to))}`,
    total: totalRows[0]?.n ?? 0,
    spent: handedIds.size + consumerIds.size + manualIds.size,
    handed: handedIds.size,
    handedPoints,
    consumerTaken: consumerIds.size,
    manual: manualIds.size,
    recent,
  };
}
