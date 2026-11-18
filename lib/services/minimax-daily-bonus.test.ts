import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import {
  accountsAccount,
  accountsDailyBonus,
  accountsProject,
  accountToken,
} from '@/lib/db/schema';
import { encryptSecret } from '@/lib/secrets/crypto';
import { accountTokenAad } from '@/lib/services/account-tokens';
import {
  dailyBonusStats,
  markBonusHanded,
  sweepDailyBonus,
} from '@/lib/services/minimax-daily-bonus';

/**
 * Гейт ежесуточного забора бонусов MiniMax (заказ владельца 18.11).
 *
 * «Каждые сутки пройтись по всем аккаунтам и активировать на них бонусы, записывать у
 * себя, у кого сколько очков сегодня активировалось, а потом в течение дня раздавать эти
 * аккаунты по запросам, зная, по сколько очков отдаётся.»
 *
 * Проверяется на настоящей схеме (pglite + наши миграции), сквозным путём: аккаунт с
 * парой токенов → обход → леджер → статистика → отметка выдачи.
 */
const refs = vi.hoisted(() => ({ current: undefined as TestDb | undefined }));
vi.mock('@/lib/db/client', () => ({
  get db() {
    return refs.current;
  },
}));

// Вендор: забор бонуса и панель — подменены, цепочка токенов — настоящая.
const claim = vi.hoisted(() => ({ claimDailyBonus: vi.fn() }));
vi.mock('@/lib/minimax/claim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/minimax/claim')>();
  return { ...actual, claimDailyBonus: claim.claimDailyBonus };
});
const oauth = vi.hoisted(() => ({ refreshAccessToken: vi.fn(), signinStatus: vi.fn() }));
vi.mock('@/lib/minimax/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/minimax/oauth')>();
  return { ...actual, refreshAccessToken: oauth.refreshAccessToken, signinStatus: oauth.signinStatus };
});

let pg: PGlite | undefined;

const OWNER_ID = 1; // admin из scripts/bootstrap.sql
const NOW = new Date('2026-11-18T05:00:00Z'); // 08:00 по Москве
const TODAY = '2026-11-18';

/** Аккаунт пула с живой цепочкой токенов. */
async function makeAccount(title: string, email: string) {
  const [row] = await refs.current!
    .insert(accountsAccount)
    .values({
      userId: OWNER_ID,
      title,
      email,
      passwordCt: '',
      passwordIv: '',
      passwordTag: '',
    })
    .returning({ id: accountsAccount.id });
  const enc = encryptSecret(
    JSON.stringify({ access: `ACCESS-${row!.id}`, refresh: `REFRESH-${row!.id}` }),
    accountTokenAad(row!.id),
  );
  await refs.current!.insert(accountToken).values({
    userId: OWNER_ID,
    accountId: row!.id,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    authTag: enc.authTag,
    expiresAt: new Date(NOW.getTime() + 6 * 3_600_000).toISOString(),
  });
  return row!.id;
}

/** Ответ вендора на забор: клетка 3, 400 очков, остаток после забора прежний. */
function claimAnswer(over: { claim_result?: number; day_no?: number; points?: number } = {}) {
  const dayNo = over.day_no ?? 3;
  const points = over.points ?? 400;
  return {
    ok: true as const,
    data: {
      claim_result: over.claim_result ?? 1,
      claim_id: 'claim-1',
      day_no: dayNo,
      points,
      expire_at_ms: NOW.getTime() + 30 * 24 * 3_600_000,
      panel: {
        days: [
          { day_no: dayNo, status: 3, points, is_today: true },
          { day_no: dayNo + 1, status: 1, points: 400, is_today: false },
        ],
      },
    },
  };
}

beforeEach(async () => {
  process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
  const t = await createTestDb();
  pg = t.pg;
  refs.current = t.db;
  claim.claimDailyBonus.mockReset();
  claim.claimDailyBonus.mockResolvedValue(claimAnswer());
  oauth.refreshAccessToken.mockReset();
  oauth.refreshAccessToken.mockResolvedValue({
    ok: true,
    data: { accessToken: 'ACCESS-NEW', refreshToken: 'REFRESH-NEW', expiresInSeconds: 43_200 },
  });
});

afterEach(async () => {
  refs.current = undefined;
  await pg?.close();
  pg = undefined;
});

describe('ежесуточный забор бонусов (D-191-бис)', () => {
  it('обход забирает бонус у каждого аккаунта и пишет леджер', async () => {
    await makeAccount('Первый', 'one@example.test');
    await makeAccount('Второй', 'two@example.test');

    const report = await sweepDailyBonus({ now: NOW });

    expect(report.date).toBe(TODAY);
    expect(report.accounts).toBe(2);
    expect(report.claimed).toBe(2);
    expect(report.already).toBe(0);
    expect(report.points).toBe(800);
    expect(claim.claimDailyBonus).toHaveBeenCalledTimes(2);

    const rows = await refs.current!.select().from(accountsDailyBonus);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({
      usedOn: TODAY,
      dayNo: 3,
      points: 400,
      remaining: 400,
      status: 3,
      claimResult: 1,
    });
  });

  it('повторный обход не плодит строки (забор идемпотентен в сутки)', async () => {
    await makeAccount('Один', 'one@example.test');
    await sweepDailyBonus({ now: NOW });

    claim.claimDailyBonus.mockResolvedValue(claimAnswer({ claim_result: 2 }));
    const second = await sweepDailyBonus({ now: NOW });

    expect(second.already).toBe(1);
    expect(second.claimed).toBe(0);
    const rows = await refs.current!.select().from(accountsDailyBonus);
    expect(rows.length).toBe(1);
  });

  it('аккаунт без цепочки токенов пропускается, а не ломает обход', async () => {
    await makeAccount('Живой', 'alive@example.test');
    const [broken] = await refs.current!
      .insert(accountsAccount)
      .values({
        userId: OWNER_ID,
        title: 'Без токена',
        email: 'broken@example.test',
        passwordCt: '',
        passwordIv: '',
        passwordTag: '',
      })
      .returning({ id: accountsAccount.id });
    expect(broken!.id).toBeGreaterThan(0);

    const report = await sweepDailyBonus({ now: NOW });

    expect(report.accounts).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.claimed).toBe(1);
  });

  it('отказ вендора — честный отказ: в леджер ничего не пишется', async () => {
    await makeAccount('Первый', 'one@example.test');
    claim.claimDailyBonus.mockResolvedValue({ ok: false, error: 'http_error', message: 'вендер молчит' });

    const report = await sweepDailyBonus({ now: NOW });

    expect(report.failed).toBe(1);
    expect(report.claimed).toBe(0);
    const rows = await refs.current!.select().from(accountsDailyBonus);
    expect(rows.length).toBe(0);
  });

  it('выдача записывается в леджер: кому и сколько очков', async () => {
    const accountId = await makeAccount('Раздаваемый', 'given@example.test');
    await sweepDailyBonus({ now: NOW });
    const [project] = await refs.current!
      .insert(accountsProject)
      .values({ userId: OWNER_ID, name: 'Мозг' })
      .returning({ id: accountsProject.id });

    await markBonusHanded(accountId, TODAY, project!.id, 400, NOW);

    const [row] = await refs.current!
      .select()
      .from(accountsDailyBonus)
      .where(eq(accountsDailyBonus.accountId, accountId));
    expect(row!.handedToProjectId).toBe(project!.id);
    expect(row!.handedPoints).toBe(400);
    expect(row!.remaining).toBe(400);
  });

  it('статистика дня: забрано, отдано, потрачено, осталось', async () => {
    const accountId = await makeAccount('Раздаваемый', 'given@example.test');
    await sweepDailyBonus({ now: NOW });
    const [project] = await refs.current!
      .insert(accountsProject)
      .values({ userId: OWNER_ID, name: 'Мозг' })
      .returning({ id: accountsProject.id });
    await markBonusHanded(accountId, TODAY, project!.id, 400, NOW);

    const stats = await dailyBonusStats(TODAY);
    expect(stats.accounts).toBe(1);
    expect(stats.claimed).toBe(1);
    expect(stats.points).toBe(400);
    expect(stats.handed).toBe(1);
    expect(stats.handedPoints).toBe(400);
    // Очки лежат на аккаунте (остаток 400) — потрачено 0, осталось 400.
    expect(stats.spentPoints).toBe(0);
    expect(stats.leftPoints).toBe(400);
    expect(stats.byCell).toEqual([{ cell: 3, accounts: 1, points: 400 }]);
    expect(stats.byProject).toEqual([{ project: 'Мозг', accounts: 1, points: 400 }]);
  });

  it('потраченные очки видны в статистике: остаток упал — потрачено', async () => {
    const accountId = await makeAccount('Работающий', 'busy@example.test');
    await sweepDailyBonus({ now: NOW });
    // Потребитель отработал часть очков: остаток 120.
    await refs.current!
      .update(accountsDailyBonus)
      .set({ remaining: 120 })
      .where(eq(accountsDailyBonus.accountId, accountId));

    const stats = await dailyBonusStats(TODAY);
    expect(stats.spentPoints).toBe(280);
    expect(stats.leftPoints).toBe(120);
  });
});
