import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import { accountPanelState, accountsAccount, accountsUsage } from '@/lib/db/schema';
import { reconcileActivations, reconcileVerdict } from '@/lib/services/minimax-reconcile';
import { PANEL_STATUS_CLAIMABLE, PANEL_STATUS_CLAIMED } from '@/lib/minimax/panel';
import type { PanelState } from '@/lib/accounts/panel-state';

/**
 * Гейт сверки журнала с панелью MiniMax (заказ владельца 17.11).
 *
 * Проверяется на настоящей схеме (pglite + наши миграции), сквозным путём:
 * строка журнала за сегодня + ответы панели → решение → БД → обратное чтение.
 *
 * Что здесь закрыто:
 * - **фантомный расход снимается**: панель говорит «очки есть» в обоих поясах →
 *   строка журнала удаляется, отметка дня снимается, аккаунт снова свободен;
 * - **реальный расход уточняется по панели**: клетка и очки берутся из панели, а не
 *   из нашей модели по датам;
 * - **«не знаю» не значит «очков нет»**: протухший или расходящийся ответ панели
 *   оставляет строку как есть.
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

/** Строка журнала за день. */
async function makeUsage(
  accountId: number,
  usedOn: string,
  tokens: number,
  activationIndex: number | null,
): Promise<void> {
  await refs.current!.insert(accountsUsage).values({
    userId: OWNER_ID,
    accountId,
    usedOn,
    tokens,
    activationIndex,
    source: 'api',
  });
}

/** Ответ панели по аккаунту в одном поясе. */
async function makePanel(
  accountId: number,
  timezoneId: string,
  status: number,
  cellNo: number,
  points: number,
  checkedAt: Date = NOW,
): Promise<void> {
  await refs.current!.insert(accountPanelState).values({
    accountId,
    timezoneId,
    userId: OWNER_ID,
    cellNo,
    status,
    points,
    canClaim: status === PANEL_STATUS_CLAIMABLE,
    checkedAt: checkedAt.toISOString(),
    updatedAt: checkedAt.toISOString(),
  });
}

/** Состояние панели для чистых проверок правила. */
function panel(
  status: number,
  cellNo: number,
  points: number,
  checkedAt: Date = NOW,
): PanelState {
  return {
    account_id: 1,
    timezone_id: 'Europe/Moscow',
    cell_no: cellNo,
    status,
    points,
    can_claim: status === PANEL_STATUS_CLAIMABLE,
    checked_at: checkedAt.toISOString(),
  };
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
  it('оба пояса говорят «очки есть» → освобождаем', () => {
    const verdict = reconcileVerdict(
      panel(PANEL_STATUS_CLAIMABLE, 1, 400),
      panel(PANEL_STATUS_CLAIMABLE, 1, 400),
      NOW,
    );
    expect(verdict.verdict).toBe('release');
  });

  it('оба пояса говорят «очки сожжены» → уточняем клетку и очки по панели', () => {
    const verdict = reconcileVerdict(
      panel(PANEL_STATUS_CLAIMED, 4, 1000),
      panel(PANEL_STATUS_CLAIMED, 4, 1000),
      NOW,
    );
    expect(verdict.verdict).toBe('correct');
    expect(verdict.cell).toBe(4);
    expect(verdict.points).toBe(1000);
  });

  /**
   * Клетку забрали (18.11): панель НЕ показывает остатка очков — `points` клетки это её
   * номинал, а не «сколько осталось». Значит, «забрали и не потратили» от «забрали и
   * потратили» панель не отличить, и освобождать такие записи нельзя: так в оборот
   * возвращались аккаунты с давно потраченными очками, и владелец получал их по кнопке
   * выдачи. Мандат владельца: аккаунт, отданный сегодня, лежит погашенным до утра.
   */
  describe('клетку забрали', () => {
    it('запись не фантом: клетку и номинал уточняем по панели', () => {
      const verdict = reconcileVerdict(
        panel(PANEL_STATUS_CLAIMED, 4, 400),
        panel(PANEL_STATUS_CLAIMED, 4, 400),
        NOW,
        400,
      );
      expect(verdict.verdict).toBe('correct');
      expect(verdict.cell).toBe(4);
      expect(verdict.points).toBe(400);
    });

    it('очки убывают — по аккаунту работают, не отпускаем', () => {
      const verdict = reconcileVerdict(
        panel(PANEL_STATUS_CLAIMED, 4, 120),
        panel(PANEL_STATUS_CLAIMED, 4, 120),
        NOW,
        400,
      );
      expect(verdict.verdict).toBe('correct');
    });

    it('очки сожжены (остаток 0) → расход настоящий', () => {
      const verdict = reconcileVerdict(
        panel(PANEL_STATUS_CLAIMED, 4, 0),
        panel(PANEL_STATUS_CLAIMED, 4, 0),
        NOW,
        400,
      );
      expect(verdict.verdict).toBe('correct');
    });

    it('забора не было (строки в леджере нет) — очки забрал потребитель, держим', () => {
      const verdict = reconcileVerdict(
        panel(PANEL_STATUS_CLAIMED, 4, 400),
        panel(PANEL_STATUS_CLAIMED, 4, 400),
        NOW,
        null,
      );
      expect(verdict.verdict).toBe('correct');
    });
  });

  it('пояса расходятся → не знаем, не трогаем', () => {
    const verdict = reconcileVerdict(
      panel(PANEL_STATUS_CLAIMABLE, 1, 400),
      panel(PANEL_STATUS_CLAIMED, 1, 0),
      NOW,
    );
    expect(verdict.verdict).toBe('skip');
  });

  it('протухший ответ панели — «не знаю», а не «очков нет»', () => {
    // Протухший ДЛЯ СВЕРКИ — старше её срока (полтора часа): аккаунты в работе
    // автосверка перечитывает раз в час (антиспам, 18.11), и при общем сроке в
    // полчаса сверка половину времени видела бы «не знаю».
    const stale = new Date(NOW.getTime() - 2 * 60 * 60_000);
    const verdict = reconcileVerdict(
      panel(PANEL_STATUS_CLAIMABLE, 1, 400, stale),
      panel(PANEL_STATUS_CLAIMABLE, 1, 400, stale),
      NOW,
    );
    expect(verdict.verdict).toBe('skip');
  });

  it('ответ часоватой давности для сверки ещё годен — не «не знаю»', () => {
    const hourOld = new Date(NOW.getTime() - 60 * 60_000);
    const verdict = reconcileVerdict(
      panel(PANEL_STATUS_CLAIMABLE, 1, 400, hourOld),
      panel(PANEL_STATUS_CLAIMABLE, 1, 400, hourOld),
      NOW,
    );
    expect(verdict.verdict).toBe('release');
  });

  it('нет ответа панели вовсе → не трогаем', () => {
    expect(reconcileVerdict(null, null, NOW).verdict).toBe('skip');
    expect(reconcileVerdict(panel(PANEL_STATUS_CLAIMABLE, 1, 400), null, NOW).verdict).toBe('skip');
  });
});

describe('сверка журнала с панелью', () => {
  it('фантомный расход снимается, реальный — уточняется по панели', async () => {
    const phantom = await makeAccount('phantom@example.test');
    await makeUsage(phantom, YESTERDAY, 400, 2);
    await makeUsage(phantom, TODAY, 400, 2);
    await makePanel(phantom, 'Europe/Moscow', PANEL_STATUS_CLAIMABLE, 1, 400);
    await makePanel(phantom, 'UTC', PANEL_STATUS_CLAIMABLE, 1, 400);

    const real = await makeAccount('real@example.test');
    await makeUsage(real, TODAY, 400, 1);
    await makePanel(real, 'Europe/Moscow', PANEL_STATUS_CLAIMED, 4, 1000);
    await makePanel(real, 'UTC', PANEL_STATUS_CLAIMED, 4, 1000);

    const unknown = await makeAccount('unknown@example.test');
    await makeUsage(unknown, TODAY, 400, 1);
    await makePanel(unknown, 'Europe/Moscow', PANEL_STATUS_CLAIMABLE, 1, 400);
    await makePanel(unknown, 'UTC', PANEL_STATUS_CLAIMED, 1, 0);

    const report = await reconcileActivations(NOW);

    expect(report.today).toBe(TODAY);
    expect(report.rows).toBe(3);
    expect(report.released).toBe(1);
    expect(report.corrected).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.releasedIds).toEqual([phantom]);
    expect(report.correctedIds).toEqual([real]);

    // Фантом: строка журнала за сегодня снята, аккаунт свободен, «последние очки» —
    // от последней настоящей активации (вчерашней).
    const phantomRows = await refs.current!
      .select()
      .from(accountsUsage)
      .where(eq(accountsUsage.accountId, phantom));
    expect(phantomRows.map((row) => row.usedOn)).toEqual([YESTERDAY]);
    const [phantomAccount] = await refs.current!
      .select()
      .from(accountsAccount)
      .where(eq(accountsAccount.id, phantom));
    expect(phantomAccount!.usedOn).toBeNull();
    expect(phantomAccount!.usedAt).toBeNull();
    expect(phantomAccount!.lastTokens).toBe(400);

    // Реальный: клетка и очки — как сказала панель.
    const [realRow] = await refs.current!
      .select()
      .from(accountsUsage)
      .where(and(eq(accountsUsage.accountId, real), eq(accountsUsage.usedOn, TODAY)));
    expect(realRow!.activationIndex).toBe(4);
    expect(realRow!.tokens).toBe(1000);
    const [realAccount] = await refs.current!
      .select()
      .from(accountsAccount)
      .where(eq(accountsAccount.id, real));
    expect(realAccount!.lastTokens).toBe(1000);

    // Неизвестное — не тронуто.
    const [unknownRow] = await refs.current!
      .select()
      .from(accountsUsage)
      .where(and(eq(accountsUsage.accountId, unknown), eq(accountsUsage.usedOn, TODAY)));
    expect(unknownRow!.tokens).toBe(400);
    expect(unknownRow!.activationIndex).toBe(1);
  });

  it('за вчерашний день не трогаем: сверка работает по сегодняшней дате', async () => {
    const account = await makeAccount('yesterday@example.test');
    await makeUsage(account, YESTERDAY, 400, 2);
    await makePanel(account, 'Europe/Moscow', PANEL_STATUS_CLAIMABLE, 1, 400);
    await makePanel(account, 'UTC', PANEL_STATUS_CLAIMABLE, 1, 400);

    const report = await reconcileActivations(NOW);
    expect(report.rows).toBe(0);
    expect(report.released).toBe(0);

    const rows = await refs.current!
      .select()
      .from(accountsUsage)
      .where(eq(accountsUsage.accountId, account));
    expect(rows).toHaveLength(1);
  });

  it('без записей за сегодня сверка — пустая и безопасная', async () => {
    const report = await reconcileActivations(NOW);
    expect(report.rows).toBe(0);
    expect(report.released).toBe(0);
    expect(report.corrected).toBe(0);
  });
});
