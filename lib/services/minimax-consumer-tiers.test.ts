import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import { secretsAudit, secretsProject } from '@/lib/db/schema';
import {
  CONSUMER_ROLES,
  OTHER_ROLE,
} from '@/lib/accounts/consumer-tiers';
import { consumerTiers } from '@/lib/services/minimax-consumer-tiers';

/**
 * Гейт статистики «куда ушли тысячные» (заказ владельца 19.11).
 *
 * «Проверь, что тысячные аккаунты отдаются в первую очередь на программирование… сделай
 * статистику, чтобы видеть реально, сколько тысячных аккаунтов ушло на программирование
 * проектов, а сколько утекло на продсервер Сарафану».
 *
 * Роль берётся из КОМНАТЫ (структурно), а не из имени проекта: комната `brain` — панели
 * программирования, `setka` — продсервер Сарафана.
 */
const refs = vi.hoisted(() => ({ current: undefined as TestDb | undefined }));
vi.mock('@/lib/db/client', () => ({
  get db() {
    return refs.current;
  },
}));

let pg: PGlite | undefined;

const OWNER_ID = 1; // admin из scripts/bootstrap.sql
const NOW = new Date('2026-11-19T08:00:00Z'); // 11:00 МСК

beforeEach(async () => {
  const t = await createTestDb();
  pg = t.pg;
  refs.current = t.db;
});

afterEach(async () => {
  await pg?.close();
});

/** Строка аудита выдачи: комната, класс очков и сколько очков ушло. */
async function issue(roomSlug: string, tier: string, points: number, at: Date) {
  await refs.current!
    .insert(secretsProject)
    .values({ userId: OWNER_ID, name: roomSlug, slug: roomSlug })
    .onConflictDoNothing();
  const [room] = await refs.current!
    .select({ id: secretsProject.id })
    .from(secretsProject)
    .where(eq(secretsProject.slug, roomSlug));
  await refs.current!
    .insert(secretsAudit)
    .values({
      projectId: room!.id,
      action: 'minimax_account_issued',
      detail: `выдан аккаунт #1 «тест»: класс ${tier}, клетка 4, очки ${points}, access отдан`,
      at: at.toISOString(),
    });
}

describe('статистика тысячных по ролям', () => {
  it('различает программирование и продсервер Сарафана по комнате', async () => {
    await issue('brain', 'points_1000', 1000, new Date('2026-11-19T07:00:00Z'));
    await issue('brain', 'points_400', 400, new Date('2026-11-19T07:30:00Z'));
    await issue('setka', 'points_400', 400, new Date('2026-11-19T08:00:00Z'));

    const tiers = await consumerTiers(30, NOW);
    const programming = tiers.byRole.find((row) => row.role === CONSUMER_ROLES.brain)!;
    const prod = tiers.byRole.find((row) => row.role === CONSUMER_ROLES.setka)!;

    expect(programming.thousands).toBe(1);
    expect(programming.fours).toBe(1);
    expect(programming.points).toBe(1400);
    expect(prod.thousands).toBe(0);
    expect(prod.fours).toBe(1);
  });

  it('тысячная, ушедшая продсерверу, видна и помечена', async () => {
    await issue('setka', 'points_1000', 1000, new Date('2026-11-19T08:00:00Z'));

    const tiers = await consumerTiers(30, NOW);
    const prod = tiers.byRole.find((row) => row.role === CONSUMER_ROLES.setka)!;
    expect(prod.thousands).toBe(1);
    expect(tiers.byDay[0]!.usedOn).toBe('2026-11-19');
    expect(tiers.byDay[0]!.thousands).toBe(1);
  });

  it('группирует по московским суткам', async () => {
    // 21:30 UTC = 00:30 МСК следующего дня — обе выдачи в московские сутки 19.11.
    await issue('brain', 'points_1000', 1000, new Date('2026-11-18T21:30:00Z'));
    await issue('brain', 'points_1000', 1000, new Date('2026-11-19T07:00:00Z'));

    const tiers = await consumerTiers(30, NOW);
    const days = tiers.byDay.map((row) => row.usedOn);
    expect(days).toEqual(['2026-11-19']);
    expect(tiers.byDay[0]!.thousands).toBe(2);
  });

  it('чужая комната — в «прочие», а не в программирование', async () => {
    await issue('karman-hotline', 'points_1000', 1000, new Date('2026-11-19T07:00:00Z'));

    const tiers = await consumerTiers(30, NOW);
    expect(tiers.byRole.map((row) => row.role)).toContain(OTHER_ROLE);
    expect(tiers.byRole.find((row) => row.role === CONSUMER_ROLES.brain)).toBeUndefined();
  });

  it('окно ограничено числом суток', async () => {
    await issue('brain', 'points_1000', 1000, new Date('2026-10-01T07:00:00Z'));
    await issue('brain', 'points_1000', 1000, new Date('2026-11-19T07:00:00Z'));

    const tiers = await consumerTiers(30, NOW);
    expect(tiers.byRole[0]!.thousands).toBe(1);
  });

  it('без выдач — пусто, а не ошибка', async () => {
    const tiers = await consumerTiers(30, NOW);
    expect(tiers.byRole).toEqual([]);
    expect(tiers.byDay).toEqual([]);
  });
});
