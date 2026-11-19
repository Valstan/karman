import { and, eq, gte } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { secretsAudit, secretsProject } from '@/lib/db/schema';
import { moscowToday } from '@/lib/accounts/rotation';
import {
  CONSUMER_ROLES,
  OTHER_ROLE,
  type ConsumerTierDay,
  type ConsumerTierRole,
  type ConsumerTiers,
} from '@/lib/accounts/consumer-tiers';

/**
 * Куда ушли тысячные аккаунты (заказ владельца 19.11).
 *
 * Вопрос был два: «проверь, что тысячные аккаунты отдаются в первую очередь на
 * программирование» и «сделай статистику, чтобы видеть реально, сколько тысячных
 * аккаунтов ушло на программирование проектов, а сколько утекло на продсервер
 * Сарафану».
 *
 * ## Почему по КОМНАТЕ, а не по имени проекта
 *
 * Класс очков выбираем **мы**, по комнате-потребителю (`TIER_PREFERENCE` в
 * `lib/services/minimax.ts`): комната `brain` — панели программирования владельца —
 * получает тысячные первыми, комната `setka` — продсервер Сарафана (фильтрация постов
 * ВК) — сначала четырёхсотковые. Имя проекта для этого НЕ годится: у владельца
 * «САРАФАН» (кириллица) и у комнаты «SARAFAN» (латиница) — разница в одном символе,
 * а ловушка, а не различие (см. комментарий в `lib/db/schema.ts`).
 *
 * ## Откуда данные
 *
 * Аудит выдач (`secrets_audit`, действие `minimax_account_issued`): в нём есть комната
 * (`project_id` → `secrets_project.slug`) — это структурно, без разбора текста. Класс и
 * номинал очков лежат в тексте подробности — разбираем их регуляркой (так же, как в
 * `docs/notes/minimax-17.11-issue-breakdown.md`).
 *
 * Роли и формат ответа — в чистом модуле `lib/accounts/consumer-tiers.ts` (его читает
 * клиентский компонент страницы — там не должно быть Node-модулей).
 */

/** Класс аккаунта в тексте аудита («класс points_1000»). */
const CLASS_RE = /класс (points_[0-9]+)/;
/** Номинал очков в тексте аудита («очки 1000»). */
const POINTS_RE = /очки ([0-9]+)/;

/**
 * Собрать статистику тысячных по ролям за `days` суток (по умолчанию — 30).
 *
 * Пусто (без строк) — не ошибка: просто никто ещё не брал аккаунтов.
 */
export async function consumerTiers(
  days = 30,
  now: Date = new Date(),
): Promise<ConsumerTiers> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await db
    .select({ at: secretsAudit.at, detail: secretsAudit.detail, room: secretsProject.slug })
    .from(secretsAudit)
    .leftJoin(secretsProject, eq(secretsAudit.projectId, secretsProject.id))
    .where(
      and(
        eq(secretsAudit.action, 'minimax_account_issued'),
        gte(secretsAudit.at, since.toISOString()),
      ),
    );

  const byDay = new Map<string, ConsumerTierDay>();
  const byRole = new Map<string, ConsumerTierRole>();

  for (const row of rows) {
    const detail = row.detail ?? '';
    const room = row.room ?? '(без комнаты)';
    const role = CONSUMER_ROLES[room] ?? OTHER_ROLE;
    const usedOn = moscowToday(new Date(row.at));
    const tier = CLASS_RE.exec(detail)?.[1];
    const points = Number(POINTS_RE.exec(detail)?.[1] ?? 0);

    const dayKey = `${usedOn}|${role}`;
    const day = byDay.get(dayKey) ?? {
      usedOn,
      role,
      room,
      thousands: 0,
      fours: 0,
      points: 0,
      issues: 0,
    };
    day.issues += 1;
    day.points += points;
    if (tier === 'points_1000') day.thousands += 1;
    if (tier === 'points_400') day.fours += 1;
    byDay.set(dayKey, day);

    const total = byRole.get(role) ?? { role, thousands: 0, fours: 0, points: 0, issues: 0 };
    total.issues += 1;
    total.points += points;
    if (tier === 'points_1000') total.thousands += 1;
    if (tier === 'points_400') total.fours += 1;
    byRole.set(role, total);
  }

  return {
    days,
    byRole: [...byRole.values()].sort(
      (a, b) => b.thousands - a.thousands || b.points - a.points || a.role.localeCompare(b.role),
    ),
    byDay: [...byDay.values()].sort(
      (a, b) => (a.usedOn < b.usedOn ? 1 : -1) || a.role.localeCompare(b.role),
    ),
  };
}
