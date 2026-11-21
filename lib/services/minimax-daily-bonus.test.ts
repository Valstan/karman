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
  operationalBonusStats,
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
function claimAnswer(
  over: { claim_result?: number; day_no?: number; points?: number; claim_id?: string } = {},
) {
  const dayNo = over.day_no ?? 3;
  const points = over.points ?? 400;
  return {
    ok: true as const,
    data: {
      claim_result: over.claim_result ?? 1,
      claim_id: over.claim_id ?? 'claim-1',
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

  it('повторный обход не обнуляет остаток у аккаунта, чью клетку забрали мы', async () => {
    // Живой случай 18.11: повторный забор возвращает 2, и если бы остаток
    // перезаписывался по «результату этого прогона», очки наших аккаунтов
    // обнулились бы и аккаунты выпали бы из выдачи.
    await makeAccount('Наш', 'ours@example.test');
    await sweepDailyBonus({ now: NOW });

    claim.claimDailyBonus.mockResolvedValue(claimAnswer({ claim_result: 2 }));
    await sweepDailyBonus({ now: NOW });

    const [row] = await refs.current!.select().from(accountsDailyBonus);
    expect(row!.claimResult).toBe(1); // «забрали мы» — не понижаем
    expect(row!.remaining).toBe(400); // и остаток на месте
  });

  it('пометка сторожа «пусто» переживает повторный обход', async () => {
    await makeAccount('Их', 'theirs@example.test');
    await sweepDailyBonus({ now: NOW });
    // Сторож признал аккаунт пустым на сегодня.
    await refs.current!
      .update(accountsDailyBonus)
      .set({ remaining: 0, claimResult: 2 })
      .where(eq(accountsDailyBonus.accountId, 1));

    claim.claimDailyBonus.mockResolvedValue(claimAnswer({ claim_result: 2 }));
    await sweepDailyBonus({ now: NOW });

    const [row] = await refs.current!.select().from(accountsDailyBonus);
    expect(row!.remaining).toBe(0); // пометка не потерялась
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

  it('сбой на одном аккаунте не обрывает обход — остальные забирают бонус', async () => {
    // Живая находка 18.11: исключение на одном аккаунте убивало обход ЦЕЛИКОМ —
    // и сутки обхода терялись: у остальных клетка вендора не сдвигалась, и серия
    // дней подряд рвалась. Теперь сбойный аккаунт считается неудачей, а обход идёт
    // дальше.
    await makeAccount('Сбойный', 'broken@example.test');
    await makeAccount('Живой', 'alive@example.test');

    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    claim.claimDailyBonus.mockImplementationOnce(async () => {
      throw new Error('вендор оборвался');
    });

    const report = await sweepDailyBonus({ now: NOW });
    quiet.mockRestore();

    expect(report.accounts).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.claimed).toBe(1);

    const rows = await refs.current!.select().from(accountsDailyBonus);
    expect(rows.length).toBe(1); // живой аккаунт в леджере есть, сбойный — нет
    expect(rows[0]!.claimResult).toBe(1);
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
    // Клетку забрали МЫ → очки наши; из них 400 отдали потребителю → на
    // аккаунтах не осталось ничего.
    expect(stats.spentPoints).toBe(0);
    expect(stats.leftPoints).toBe(0);
    expect(stats.byCell).toEqual([{ cell: 3, accounts: 1, points: 400 }]);
    expect(stats.byProject).toEqual([{ project: 'Мозг', accounts: 1, points: 400 }]);
  });

  it('потраченные очки видны в статистике: клетку забрал потребитель', async () => {
    const accountId = await makeAccount('Работающий', 'busy@example.test');
    await sweepDailyBonus({ now: NOW });
    // Клетку забрал НЕ мы (потребитель — обычно ночью, когда аккаунт не
    // использовали): очки у него, и он их потратил. Панель остатка не
    // показывает, поэтому признак — claim_result.
    await refs.current!
      .update(accountsDailyBonus)
      .set({ claimResult: 2 })
      .where(eq(accountsDailyBonus.accountId, accountId));

    const stats = await dailyBonusStats(TODAY);
    expect(stats.claimed).toBe(0);
    expect(stats.already).toBe(1);
    expect(stats.spentPoints).toBe(400);
    expect(stats.leftPoints).toBe(0);
  });

  it('выдача видна в статистике: кому и сколько очков отдали', async () => {
    // Заказ владельца 19.11: выдача — след, по которому видно, кто и сколько взял.
    const accountId = await makeAccount('Раздаваемый', 'given@example.test');
    await sweepDailyBonus({ now: NOW });
    await markBonusHanded(accountId, TODAY, null, 400, NOW);

    const stats = await dailyBonusStats(TODAY);
    expect(stats.handed).toBe(1);
    expect(stats.handedPoints).toBe(400);
  });
});

/**
 * Сводка по операционным суткам 05:00→05:00 МСК (заказ владельца 21.11).
 *
 * Сутки владельца начинаются в 05:00 МСК — в этот момент утренний обход забирает
 * бонусы. Значит забор между 00:00 и 05:00 относится к ПРЕДЫДУЩИМ суткам, даже
 * если по календарной дате он «сегодняшний». Считаем по времени события, а не по
 * `used_on` строки леджера.
 */
describe('сводка по операционным суткам 05:00→05:00 МСК', () => {
  /** 04:00 МСК 18.11 — сутки ещё вчерашние (смена в 05:00). */
  const EARLY = new Date('2026-11-18T01:00:00Z');
  /** 08:00 МСК 18.11 — сутки сегодняшние. */
  const LATE = NOW;

  it('подпись окна и забор внутри окна — в текущие сутки', async () => {
    await makeAccount('Первый', 'one@example.test');
    await makeAccount('Второй', 'two@example.test');
    await sweepDailyBonus({ now: LATE });

    const stats = await operationalBonusStats(LATE);

    expect(stats.label).toBe('18.11 → 19.11');
    expect(stats.collected).toBe(2);
    expect(stats.collectedPoints).toBe(800);
    expect(stats.handed).toBe(0);
    expect(stats.consumerTaken).toBe(0);
    // Остаток — сток на аккаунтах, а не «за окно»: обе клетки на месте.
    expect(stats.stockPoints).toBe(800);
    expect(stats.stockAccounts).toBe(2);
  });

  it('выдача считается по времени выдачи, а остаток — сток, а не окно', async () => {
    const accountId = await makeAccount('Раздаваемый', 'given@example.test');
    const stockId = await makeAccount('Копящий', 'stock@example.test');
    await sweepDailyBonus({ now: LATE });
    await markBonusHanded(accountId, TODAY, null, 400, LATE);

    const stats = await operationalBonusStats(LATE);

    expect(stats.handed).toBe(1);
    expect(stats.handedPoints).toBe(400);
    // Отданная клетка в остатке не числится — остался только копящий аккаунт.
    expect(stats.stockPoints).toBe(400);
    expect(stats.stockAccounts).toBe(1);
    expect(stockId).toBeGreaterThan(0);
  });

  it('забор ДО 05:00 МСК — в предыдущие сутки, хотя по календарю он сегодняшний', async () => {
    await makeAccount('Ночной', 'night@example.test');
    await sweepDailyBonus({ now: EARLY });

    // Спросили в 04:00 МСК — сутки вчерашние (17.11 → 18.11).
    const atNight = await operationalBonusStats(EARLY);
    expect(atNight.label).toBe('17.11 → 18.11');
    expect(atNight.collected).toBe(1);
    expect(atNight.collectedPoints).toBe(400);

    // Спросили после смены суток (08:00 МСК) — этот забор уже вчерашний.
    const atMorning = await operationalBonusStats(LATE);
    expect(atMorning.label).toBe('18.11 → 19.11');
    expect(atMorning.collected).toBe(0);
    // Но остаток он всё равно увеличил — сток он не привязан к окну.
    expect(atMorning.stockPoints).toBe(400);
  });

  it('темп — по полным операционным суткам; текущее окно в срез не входит', async () => {
    // Прошлые сутки: обход 17.11 08:00 МСК и выдача в тот же час.
    const yesterday = await makeAccount('Вчерашний', 'yesterday@example.test');
    await sweepDailyBonus({ now: new Date('2026-11-17T05:00:00Z') });
    await markBonusHanded(yesterday, '2026-11-17', null, 400, new Date('2026-11-17T05:00:00Z'));

    // Текущие сутки: обход и выдача внутри окна — в срез темпа не входят.
    const today = await makeAccount('Сегодняшний', 'today@example.test');
    await sweepDailyBonus({ now: LATE });
    await markBonusHanded(today, TODAY, null, 400, LATE);

    const stats = await operationalBonusStats(LATE);

    expect(stats.sliceTo).toBe('2026-11-17');
    expect(stats.sliceDays).toBe(1);
    expect(stats.pointsPerDay).toBe(400);
  });

  it('клетку забрал потребитель — эти очки не наши', async () => {
    const accountId = await makeAccount('Работающий', 'busy@example.test');
    await sweepDailyBonus({ now: LATE });
    await refs.current!
      .update(accountsDailyBonus)
      .set({ claimResult: 2 })
      .where(eq(accountsDailyBonus.accountId, accountId));

    const stats = await operationalBonusStats(LATE);

    expect(stats.collected).toBe(0);
    expect(stats.consumerTaken).toBe(1);
    expect(stats.consumerTakenPoints).toBe(400);
    // Чужую клетку в наш остаток не кладём.
    expect(stats.stockPoints).toBe(0);
  });
});

/**
 * Правда о бонусах — по строкам, одна строка одно утверждение (заказ владельца
 * 21.11: «какая-то каша малаша, одна строка про одно говорит, вторая ей
 * противоречит… где тут правда»).
 *
 * - остаток разделён на «сегодня» и «с прошлых суток»;
 * - «нитки бонусов» — текущая клетка вендора по аккаунтам и проверка, что нить
 *   не рвалась.
 */
describe('правда о бонусах: остаток по суткам и нитки клеток', () => {
  const LATE = NOW; // 08:00 МСК 18.11 — сутки 18.11 → 19.11
  const YESTERDAY = new Date('2026-11-17T05:00:00Z'); // 08:00 МСК 17.11

  /** Строка леджера — как её пишет обход, но с нужным нам моментом забора. */
  async function addBonusRow(over: {
    accountId: number;
    usedOn: string;
    dayNo: number;
    points: number;
    claimedAt: string;
    claimResult?: number;
    handedAt?: string | null;
  }) {
    await refs.current!.insert(accountsDailyBonus).values({
      userId: OWNER_ID,
      accountId: over.accountId,
      usedOn: over.usedOn,
      dayNo: over.dayNo,
      points: over.points,
      remaining: over.points,
      status: 3,
      claimResult: over.claimResult ?? 1,
      claimId: `claim-${over.accountId}-${over.usedOn}`,
      expireAt: new Date(NOW.getTime() + 30 * 24 * 3_600_000).toISOString(),
      claimedAt: over.claimedAt,
      checkedAt: over.claimedAt,
      handedAt: over.handedAt ?? null,
    });
  }

  it('остаток делится на свежие клетки и клетки прошлых суток', async () => {
    // Вчерашний забор — клетка прошлых суток, сегодняшний — свежая.
    const oldId = await makeAccount('Вчерашний', 'old@example.test');
    await addBonusRow({
      accountId: oldId,
      usedOn: '2026-11-17',
      dayNo: 3,
      points: 400,
      claimedAt: YESTERDAY.toISOString(),
    });
    const freshId = await makeAccount('Сегодняшний', 'fresh@example.test');
    await addBonusRow({
      accountId: freshId,
      usedOn: '2026-11-18',
      dayNo: 4,
      points: 1000,
      claimedAt: LATE.toISOString(),
    });

    const stats = await operationalBonusStats(LATE);

    // Свежий остаток — только то, что забрали в текущем окне.
    expect(stats.freshPoints).toBe(1000);
    expect(stats.freshCells).toBe(1);
    expect(stats.freshAccounts).toBe(1);
    // Прошлые сутки — отдельно: это вчерашний забор, который никто не забрал.
    expect(stats.olderPoints).toBe(400);
    expect(stats.olderCells).toBe(1);
    // А общий остаток — сумма обеих частей (старый счёт «на аккаунтах 173 200»
    // смешивал две разные вещи).
    expect(stats.stockPoints).toBe(1400);
    expect(stats.stockAccounts).toBe(2);
  });

  it('тысячные, которые ждут в пуле, считаются отдельно', async () => {
    const thousandId = await makeAccount('Тысячный', 'thousand@example.test');
    await addBonusRow({
      accountId: thousandId,
      usedOn: '2026-11-18',
      dayNo: 4,
      points: 1000,
      claimedAt: LATE.toISOString(),
    });
    const fourId = await makeAccount('Четырёхсотковый', 'four@example.test');
    await addBonusRow({
      accountId: fourId,
      usedOn: '2026-11-18',
      dayNo: 5,
      points: 400,
      claimedAt: LATE.toISOString(),
    });

    const stats = await operationalBonusStats(LATE);

    expect(stats.freshThousands).toBe(1);
    expect(stats.freshThousandsPoints).toBe(1000);
    expect(stats.thousands).toBe(1);
    expect(stats.claimedAccounts).toBe(2);
    expect(stats.collected).toBe(2);
    expect(stats.collectedPoints).toBe(1400);
  });

  it('нитки бонусов: клетка у каждого растёт на 1 в сутки — серия не сгорела', async () => {
    const alive = await makeAccount('Живой', 'alive@example.test');
    await addBonusRow({
      accountId: alive,
      usedOn: '2026-11-17',
      dayNo: 3,
      points: 400,
      claimedAt: YESTERDAY.toISOString(),
    });
    await addBonusRow({
      accountId: alive,
      usedOn: '2026-11-18',
      dayNo: 4,
      points: 1000,
      claimedAt: LATE.toISOString(),
    });

    const stats = await operationalBonusStats(LATE);

    expect(stats.seriesBroken).toBe(0);
    // Текущая клетка аккаунта — последняя (4-я, тысячная).
    expect(stats.cells).toEqual([{ cell: 4, points: 1000, accounts: 1 }]);
  });

  it('сгоревшая серия видна: клетка не выросла на 1', async () => {
    const broken = await makeAccount('Сгоревший', 'broken@example.test');
    await addBonusRow({
      accountId: broken,
      usedOn: '2026-11-17',
      dayNo: 3,
      points: 400,
      claimedAt: YESTERDAY.toISOString(),
    });
    // Клетка вендора сбросилась на первую — нить оборвалась.
    await addBonusRow({
      accountId: broken,
      usedOn: '2026-11-18',
      dayNo: 1,
      points: 400,
      claimedAt: LATE.toISOString(),
    });

    const stats = await operationalBonusStats(LATE);

    expect(stats.seriesBroken).toBe(1);
    expect(stats.cells).toEqual([{ cell: 1, points: 400, accounts: 1 }]);
  });
});
