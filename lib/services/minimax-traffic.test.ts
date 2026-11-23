import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import {
  accountsAccount,
  accountsDailyBonus,
  accountsUsage,
  secretsAudit,
  secretsProject,
} from '@/lib/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import { trafficStats } from '@/lib/services/minimax-traffic';

/**
 * Гейт блока «Текучка» (заказ владельца 23.11): сколько аккаунтов в системе,
 * сколько потрачено сегодня, сколько осталось и какие были последние выдачи.
 *
 * Проверяется на настоящей схеме (pglite + наши миграции): окно суток
 * 05:00→05:00 МСК, леджер бонусов, журнал активаций и аудит комнат.
 */
const refs = vi.hoisted(() => ({ current: undefined as TestDb | undefined }));
vi.mock('@/lib/db/client', () => ({
  get db() {
    return refs.current;
  },
}));

let pg: PGlite | undefined;

const OWNER_ID = 1; // admin из scripts/bootstrap.sql
const OWNER: SessionUser = {
  id: OWNER_ID,
  username: 'admin',
  email: 'admin@example.com',
  firstName: 'Владелец',
  lastName: '',
  isSuperuser: true,
};

// 13:00 МСК → операционные сутки 23.11: окно [2026-11-23T02:00Z, 2026-11-24T02:00Z).
const NOW = new Date('2026-11-23T10:00:00Z');
const IN_WINDOW = '2026-11-23T05:00:00.000Z';
const BEFORE_WINDOW = '2026-11-22T05:00:00.000Z';

/** Аккаунт пула. */
async function makeAccount(title: string): Promise<number> {
  const [row] = await refs.current!
    .insert(accountsAccount)
    .values({
      userId: OWNER_ID,
      title,
      email: `${title.toLowerCase().replace(/\s+/g, '.')}@example.com`,
      passwordCt: '',
      passwordIv: '',
      passwordTag: '',
    })
    .returning({ id: accountsAccount.id });
  return row!.id;
}

beforeEach(async () => {
  const t = await createTestDb();
  pg = t.pg;
  refs.current = t.db;
});

afterEach(async () => {
  await pg?.close();
  refs.current = undefined;
});

describe('блок «Текучка»', () => {
  it('пустая база — нули, а не ошибка', async () => {
    const stats = await trafficStats(OWNER, NOW);
    expect(stats.total).toBe(0);
    expect(stats.spent).toBe(0);
    expect(stats.handed).toBe(0);
    expect(stats.consumerTaken).toBe(0);
    expect(stats.manual).toBe(0);
    expect(stats.recent).toEqual([]);
    expect(stats.label).toBe('23.11 → 24.11');
  });

  it('считает аккаунты в системе и потраченные за сутки', async () => {
    const first = await makeAccount('Матрица РМЗ — 1');
    const second = await makeAccount('Матрица РМЗ — 2');
    const third = await makeAccount('Матрица РМЗ — 3');

    // Выдали аккаунт в окне (комнате) — 1000 очков.
    await refs.current!
      .insert(accountsDailyBonus)
      .values({
        userId: OWNER_ID,
        accountId: first,
        usedOn: '2026-11-23',
        dayNo: 7,
        points: 1000,
        claimResult: 1,
        claimedAt: IN_WINDOW,
        handedAt: IN_WINDOW,
        handedPoints: 1000,
      });
    // Клетку забрал потребитель (мимо нас) — очки сгорели у него.
    await refs.current!
      .insert(accountsDailyBonus)
      .values({
        userId: OWNER_ID,
        accountId: third,
        usedOn: '2026-11-23',
        dayNo: 3,
        points: 400,
        claimResult: 2,
        claimedAt: IN_WINDOW,
      });
    // Выдача ВЧЕРА — за окном суток не считается.
    await refs.current!
      .insert(accountsDailyBonus)
      .values({
        userId: OWNER_ID,
        accountId: second,
        usedOn: '2026-11-22',
        dayNo: 3,
        points: 400,
        claimResult: 1,
        claimedAt: BEFORE_WINDOW,
        handedAt: BEFORE_WINDOW,
        handedPoints: 400,
      });

    const stats = await trafficStats(OWNER, NOW);
    expect(stats.total).toBe(3);
    expect(stats.handed).toBe(1);
    expect(stats.handedPoints).toBe(1000);
    expect(stats.consumerTaken).toBe(1);
    expect(stats.spent).toBe(2);
  });

  it('аккаунт, посчитанный дважды, потрачен один раз', async () => {
    const account = await makeAccount('Матрица РМЗ — 1');
    // Выдача пишется и в леджер, и в журнал активаций — а потрачен он один раз.
    await refs.current!
      .insert(accountsDailyBonus)
      .values({
        userId: OWNER_ID,
        accountId: account,
        usedOn: '2026-11-23',
        dayNo: 7,
        points: 1000,
        claimResult: 1,
        claimedAt: IN_WINDOW,
        handedAt: IN_WINDOW,
        handedPoints: 1000,
      });
    await refs.current!
      .insert(accountsUsage)
      .values({
        userId: OWNER_ID,
        accountId: account,
        usedOn: '2026-11-23',
        tokens: 1000,
        source: 'api',
        createdAt: IN_WINDOW,
      });

    const stats = await trafficStats(OWNER, NOW);
    expect(stats.handed).toBe(1);
    expect(stats.manual).toBe(0);
    expect(stats.spent).toBe(1);
  });

  it('ручная активация владельцем видна отдельной группой', async () => {
    const account = await makeAccount('Матрица РМЗ — 1');
    await refs.current!
      .insert(accountsUsage)
      .values({
        userId: OWNER_ID,
        accountId: account,
        usedOn: '2026-11-23',
        tokens: 400,
        source: 'owner',
        createdAt: IN_WINDOW,
      });

    const stats = await trafficStats(OWNER, NOW);
    expect(stats.manual).toBe(1);
    expect(stats.spent).toBe(1);
  });

  it('последние выдачи берутся из аудита: комната, проект и очки', async () => {
    const account = await makeAccount('Матрица РМЗ — 1');
    await refs.current!
      .insert(secretsProject)
      .values({ userId: OWNER_ID, name: 'brain', slug: 'brain' });
    const [room] = await refs.current!
      .select({ id: secretsProject.id })
      .from(secretsProject)
      .where(eq(secretsProject.slug, 'brain'));
    await refs.current!
      .insert(secretsAudit)
      .values({
        projectId: room!.id,
        action: 'minimax_account_issued',
        detail:
          `выдан аккаунт #${account} «Матрица РМЗ — 1»: класс points_1000, клетка 7, ` +
          'очки 1000 (забор при выдаче, claim 1), access отдан, область programming, ' +
          'проект MatricaRMZ, жизнь access 720 мин',
        at: IN_WINDOW,
      });

    const stats = await trafficStats(OWNER, NOW);
    expect(stats.recent).toHaveLength(1);
    const issue = stats.recent[0]!;
    expect(issue.accountId).toBe(account);
    expect(issue.room).toBe('brain');
    expect(issue.project).toBe('MatricaRMZ');
    expect(issue.area).toBe('programming');
    expect(issue.points).toBe(1000);
    expect(issue.owner).toBe(false);
  });

  it('выдача владельца (кнопка «Выдать аккаунт») попадает в список', async () => {
    const account = await makeAccount('Матрица РМЗ — 1');
    await refs.current!
      .insert(accountsDailyBonus)
      .values({
        userId: OWNER_ID,
        accountId: account,
        usedOn: '2026-11-23',
        dayNo: 7,
        points: 1000,
        claimResult: 1,
        claimedAt: IN_WINDOW,
        handedAt: IN_WINDOW,
        handedPoints: 1000,
      });

    const stats = await trafficStats(OWNER, NOW);
    expect(stats.recent).toHaveLength(1);
    expect(stats.recent[0]!.owner).toBe(true);
    expect(stats.recent[0]!.points).toBe(1000);
    expect(stats.recent[0]!.title).toBe('Матрица РМЗ — 1');
  });

  it('в списке — свежие сверху, и их не больше десяти', async () => {
    for (let i = 0; i < 12; i += 1) {
      const account = await makeAccount(`Матрица РМЗ — ${i}`);
      await refs.current!
        .insert(accountsDailyBonus)
        .values({
          userId: OWNER_ID,
          accountId: account,
          usedOn: '2026-11-23',
          dayNo: 7,
          points: 400,
          claimResult: 1,
          claimedAt: IN_WINDOW,
          handedAt: new Date(Date.parse(IN_WINDOW) + i * 60_000).toISOString(),
          handedPoints: 400,
        });
    }

    const stats = await trafficStats(OWNER, NOW);
    expect(stats.recent).toHaveLength(10);
    const times = stats.recent.map((issue) => issue.at);
    expect([...times].sort().reverse()).toEqual(times);
  });
});
