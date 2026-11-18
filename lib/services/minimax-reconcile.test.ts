import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import { accountsAccount, accountsDailyBonus, accountsUsage } from '@/lib/db/schema';
import { reconcileActivations, reconcileVerdict } from '@/lib/services/minimax-reconcile';
import { CLAIM_RESULT_ALREADY, CLAIM_RESULT_CLAIMED } from '@/lib/minimax/claim';

/**
 * Гейт сторожа (модуль возврата аккаунтов в оборот; заказ владельца 17.11, правила
 * уточнены 18.11).
 *
 * Проверяется на настоящей схеме (pglite + наши миграции), сквозным путём:
 * строка журнала за сегодня + строка леджера забора → решение → БД → обратное чтение.
 *
 * Что здесь закрыто:
 * - **клетку забрали мы** → очки наши, аккаунт возвращается в оборот: строка журнала
 *   удаляется, отметка дня снимается;
 * - **клетку забрал потребитель** → очки у него и потрачены: аккаунт попадает в список
 *   погашенных на сегодня (до 05:00 следующего дня его не перепроверяем);
 * - **забора не было** → очки ещё появятся, не трогаем.
 */
const refs = vi.hoisted(() => ({ current: undefined as TestDb | undefined }));
vi.mock('@/lib/db/client', () => ({
  get db() {
    return refs.current;
  },
}));

let pg: PGlite | undefined;

const OWNER_ID = 1;
const NOW = new Date('2026-11-17T12:00:00Z'); // 15:00 по Москве
const TODAY = '2026-11-17';
const YESTERDAY = '2026-11-16';

/** Аккаунт пула. */
async function makeAccount(email: string): Promise<number> {
  const [row] = await refs.current!
    .insert(accountsAccount)
    .values({
      userId: OWNER_ID,
      title: email,
      email,
      passwordCt: '',
      passwordIv: '',
      passwordTag: '',
    })
    .returning({ id: accountsAccount.id });
  return row!.id;
}

/**
 * Строка журнала за день.
 *
 * `createdAt` — время ВЫДАЧИ: по нему сторож идёт по дереву выдачи вверх по времени
 * и по нему же отсекает выдачи моложе получаса (мадат владельца 18.11, 21:40 МСК).
 * По умолчанию — час назад: «уже можно проверять».
 */
async function makeUsage(
  accountId: number,
  usedOn: string,
  tokens: number,
  activationIndex: number | null,
  createdAt: Date = new Date(NOW.getTime() - 60 * 60_000),
): Promise<void> {
  await refs.current!.insert(accountsUsage).values({
    userId: OWNER_ID,
    accountId,
    usedOn,
    tokens,
    activationIndex,
    source: 'api',
    createdAt: createdAt.toISOString(),
  });
}

/** Строка леджера забора за сегодня: кто забрал клетку и что с очками. */
async function makeLedger(
  accountId: number,
  row: {
    claimResult: number;
    remaining: number | null;
    dayNo: number;
    points: number;
  },
): Promise<void> {
  await refs.current!.insert(accountsDailyBonus).values({
    userId: OWNER_ID,
    accountId,
    usedOn: TODAY,
    dayNo: row.dayNo,
    points: row.points,
    remaining: row.remaining,
    status: 3,
    claimResult: row.claimResult,
    claimId: 'claim-1',
    claimedAt: NOW.toISOString(),
    checkedAt: NOW.toISOString(),
  });
}

beforeEach(async () => {
  process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
  const t = await createTestDb();
  pg = t.pg;
  refs.current = t.db;
});

afterEach(async () => {
  refs.current = undefined;
  await pg?.close();
  pg = undefined;
});

describe('правило сверки (чистая функция)', () => {
  /**
   * Сторож работает по нашему леджеру забора: панель остатка очков НЕ отдаёт
   * (`points` клетки — её номинал, а не «сколько осталось»; живая проверка
   * 18.11), так что признак один — `claim_result` из ответа на забор.
   */
  it('забора сегодня не было — очки ещё появятся, до утра не трогаем', () => {
    expect(reconcileVerdict(null, null).verdict).toBe('skip');
  });

  it('клетку забрали мы — очки наши: аккаунт возвращается в оборот', () => {
    expect(reconcileVerdict(CLAIM_RESULT_CLAIMED, 400).verdict).toBe('release');
  });

  it('клетку забрал потребитель — очки потрачены: в список погашенных на сегодня', () => {
    expect(reconcileVerdict(CLAIM_RESULT_ALREADY, null).verdict).toBe('spent');
  });

  it('уже признан пустым на сегодня — повторно не проверяем (до 05:00 следующего дня)', () => {
    expect(reconcileVerdict(CLAIM_RESULT_CLAIMED, 0).verdict).toBe('skip');
    expect(reconcileVerdict(CLAIM_RESULT_ALREADY, 0).verdict).toBe('skip');
  });

  it('неизвестный результат забора → не трогаем', () => {
    expect(reconcileVerdict(3, 400).verdict).toBe('skip');
  });
});

describe('сторож: журнал и леджер', () => {
  it('клетку забрали мы → запись ВЫДАЧИ остаётся, аккаунт снова свободен', async () => {
    const account = await makeAccount('ours@example.test');
    await makeUsage(account, YESTERDAY, 400, 2);
    await makeUsage(account, TODAY, 400, 3);
    await makeLedger(account, { claimResult: CLAIM_RESULT_CLAIMED, remaining: 400, dayNo: 3, points: 400 });

    const report = await reconcileActivations(NOW);

    expect(report.today).toBe(TODAY);
    expect(report.rows).toBe(1);
    expect(report.released).toBe(1);
    expect(report.releasedIds).toEqual([account]);

    // ЗАПИСЬ ВЫДАЧИ ОСТАЁТСЯ (мадат владельца 18.11, 21:40 МСК: «вести статистику
    // аккаунтов, которые были выданы, точки времени»). Освобождается только СЕССИЯ
    // аккаунта — она и держала его занятым.
    const rows = await refs.current!
      .select()
      .from(accountsUsage)
      .where(eq(accountsUsage.accountId, account));
    expect(rows.map((row) => row.usedOn).sort()).toEqual([YESTERDAY, TODAY]);
    const [row] = await refs.current!
      .select()
      .from(accountsAccount)
      .where(eq(accountsAccount.id, account));
    expect(row!.usedOn).toBeNull();
    expect(row!.usedAt).toBeNull();
    expect(row!.lastTokens).toBe(400);
  });

  it('выдачу моложе получаса не трогаем — возможно, потребитель ещё в работе', async () => {
    // Мандат владельца 18.11, 21:40 МСК: «последние полчаса не трогать, то что там
    // выдали, возможно ещё в работе и проверять его ещё рано».
    const account = await makeAccount('fresh@example.test');
    await makeUsage(account, TODAY, 400, 3, new Date(NOW.getTime() - 5 * 60_000));
    await makeLedger(account, { claimResult: CLAIM_RESULT_CLAIMED, remaining: 400, dayNo: 3, points: 400 });

    const report = await reconcileActivations(NOW);

    expect(report.rows).toBe(0);
    expect(report.released).toBe(0);
    const [row] = await refs.current!
      .select()
      .from(accountsAccount)
      .where(eq(accountsAccount.id, account));
    expect(row!.usedAt).toBeNull();
  });

  it('идём по дереву выдачи вверх от курсора: проверенное раньше не перепроверяем', async () => {
    const old = await makeAccount('old@example.test');
    const fresh = await makeAccount('new@example.test');
    const cursor = new Date(NOW.getTime() - 50 * 60_000);
    await makeUsage(old, TODAY, 400, 3, new Date(NOW.getTime() - 90 * 60_000));
    await makeUsage(fresh, TODAY, 400, 3, new Date(NOW.getTime() - 45 * 60_000));
    for (const account of [old, fresh]) {
      await makeLedger(account, {
        claimResult: CLAIM_RESULT_CLAIMED,
        remaining: 400,
        dayNo: 3,
        points: 400,
      });
    }

    const report = await reconcileActivations(NOW, { cursor: cursor.toISOString() });

    // Только выдача новее курсора.
    expect(report.rows).toBe(1);
    expect(report.releasedIds).toEqual([fresh]);
    expect(report.cursor).toBe(new Date(NOW.getTime() - 45 * 60_000).toISOString());
  });

  it('клетку забрал потребитель → запись остаётся, аккаунт в списке погашенных', async () => {
    const account = await makeAccount('theirs@example.test');
    await makeUsage(account, TODAY, 1000, 4);
    await makeLedger(account, {
      claimResult: CLAIM_RESULT_ALREADY,
      remaining: null,
      dayNo: 4,
      points: 1000,
    });

    const report = await reconcileActivations(NOW);

    expect(report.spent).toBe(1);
    expect(report.spentIds).toEqual([account]);
    expect(report.released).toBe(0);

    // Журнальная запись на месте, но клетка и очки уточнены по леджеру (там ответ
    // вендора на забор).
    const [usage] = await refs.current!
      .select()
      .from(accountsUsage)
      .where(and(eq(accountsUsage.accountId, account), eq(accountsUsage.usedOn, TODAY)));
    expect(usage!.activationIndex).toBe(4);
    expect(usage!.tokens).toBe(1000);

    // Остаток = 0: до утра следующего дня сторож этот аккаунт не перепроверяет.
    const [ledger] = await refs.current!
      .select()
      .from(accountsDailyBonus)
      .where(and(eq(accountsDailyBonus.accountId, account), eq(accountsDailyBonus.usedOn, TODAY)));
    expect(ledger!.remaining).toBe(0);
  });

  it('забора не было — не трогаем (очки ещё появятся)', async () => {
    const account = await makeAccount('noclaim@example.test');
    await makeUsage(account, TODAY, 400, 1);

    const report = await reconcileActivations(NOW);

    expect(report.rows).toBe(1);
    expect(report.released).toBe(0);
    expect(report.spent).toBe(0);
    expect(report.skipped).toBe(1);
    const rows = await refs.current!
      .select()
      .from(accountsUsage)
      .where(eq(accountsUsage.accountId, account));
    expect(rows).toHaveLength(1);
  });

  it('за вчерашний день не трогаем: сторож работает по сегодняшней дате', async () => {
    const account = await makeAccount('yesterday@example.test');
    await makeUsage(account, YESTERDAY, 400, 2);

    const report = await reconcileActivations(NOW);
    expect(report.rows).toBe(0);
    expect(report.released).toBe(0);

    const rows = await refs.current!
      .select()
      .from(accountsUsage)
      .where(eq(accountsUsage.accountId, account));
    expect(rows).toHaveLength(1);
  });

  it('без записей за сегодня сторож — пустой и безопасный', async () => {
    const report = await reconcileActivations(NOW);
    expect(report.rows).toBe(0);
    expect(report.released).toBe(0);
    expect(report.corrected).toBe(0);
  });
});
