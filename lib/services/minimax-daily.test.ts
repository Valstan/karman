import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import { accountToken, accountsAccount, accountsDailyBonus, accountsUsage } from '@/lib/db/schema';
import { encryptSecret } from '@/lib/secrets/crypto';
import type { SessionUser } from '@/lib/auth/rbac';

/**
 * Гейт сверки суток с панелью MiniMax (15.11; durable-состояние — 16.11).
 *
 * Проверяем главное: чтение панели НЕ ТРАТИТ очки и даёт честный ответ «очки
 * можно забрать» / «очки сожжены» — а именно этот ответ решает, кому отдавать
 * аккаунт. Модель панели в `lib/minimax/oauth.test.ts`.
 *
 * С 16.11 состояние лежит в БД (`account_panel_state`), а не в памяти процесса:
 * переживает рестарт и одинаково видно выдаче, странице и автосверке.
 */

const oauth = vi.hoisted(() => ({ signinStatus: vi.fn() }));

vi.mock('@/lib/minimax/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/minimax/oauth')>();
  return { ...actual, signinStatus: oauth.signinStatus };
});

const refs = vi.hoisted(() => ({ current: undefined as TestDb | undefined }));
vi.mock('@/lib/db/client', () => ({
  get db() {
    return refs.current;
  },
}));

import {
  dailyStateFor,
  dailyStates,
  DEFAULT_TIMEZONE,
  OWNER_TIMEZONE,
  panelSweepDecision,
  panelSweepTargets,
  sweepPanelStates,
  syncDailyStates,
  timezoneForRoom,
} from '@/lib/services/minimax-daily';
import { readPanelStates } from '@/lib/accounts/panel-state';
import { PANEL_IN_WORK_REFRESH_MS, PANEL_REFRESH_AGE_MS } from '@/lib/accounts/panel-state';
import { moscowToday } from '@/lib/accounts/rotation';

let pg: PGlite | undefined;

const owner: SessionUser = {
  id: 1,
  username: 'admin',
  email: '',
  firstName: '',
  lastName: '',
  isSuperuser: true,
};

function panelResponse(canClaim: boolean) {
  return {
    ok: true as const,
    data: {
      days: [
        { day_no: 4, status: 3, points: 1000, is_today: false },
        { day_no: 5, status: canClaim ? 2 : 3, points: 400, is_today: true },
      ],
      today: { day_no: 5, status: canClaim ? 2 : 3, points: 400, is_today: true },
      canClaim,
      points: 400,
    },
  };
}

async function makeAccountWithPair(email: string): Promise<number> {
  const [row] = await refs.current!
    .insert(accountsAccount)
    .values({
      userId: owner.id,
      title: email,
      email,
      passwordCt: '',
      passwordIv: '',
      passwordTag: '',
    })
    .returning({ id: accountsAccount.id });
  const id = row!.id;
  const enc = encryptSecret(
    JSON.stringify({ access: 'ACCESS-1', refresh: 'REFRESH-1' }),
    `accounts:account:${id}:token`,
  );
  await refs.current!.insert(accountToken).values({
    userId: owner.id,
    accountId: id,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    authTag: enc.authTag,
    // Access живёт долго: тесты двигают «сейчас» на часы вперёд, и протухший
    // access ушёл бы в refresh (сеть в тесте недоступна).
    expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString(),
  });
  return id;
}

beforeEach(async () => {
  process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
  const t = await createTestDb();
  pg = t.pg;
  refs.current = t.db;
  oauth.signinStatus.mockReset();
});

afterEach(async () => {
  refs.current = undefined;
  await pg?.close();
  pg = undefined;
});

describe('сверка суток: часовые пояса', () => {
  it('панель программирования — пояс владельца, остальные — поздний (UTC)', () => {
    // Сутки MiniMax считаются по поясу ЗАПРОСА: панель владельца (Europe/Moscow)
    // переходит на новые сутки в полночь, а запросы Сарафана (UTC) — в 03:00 МСК.
    // Для выдачи берём поздний: тогда очки есть у обеих сторон.
    expect(timezoneForRoom('brain')).toBe(OWNER_TIMEZONE);
    expect(timezoneForRoom('setka')).toBe(DEFAULT_TIMEZONE);
    expect(DEFAULT_TIMEZONE).toBe('UTC');
  });
});

describe('сверка суток: чтение панели', () => {
  it('читает состояние клетки и сохраняет его в БД', async () => {
    const accountId = await makeAccountWithPair('panel@example.test');
    oauth.signinStatus.mockResolvedValue(panelResponse(true));

    const state = await dailyStateFor(accountId, OWNER_TIMEZONE, new Date(), {
      force: true,
      userId: owner.id,
    });
    expect(state).not.toBeNull();
    expect(state!.can_claim).toBe(true);
    expect(state!.points).toBe(400);
    expect(state!.cell_no).toBe(5);

    // Повторное чтение — из БД, без похода в MiniMax: состояние живёт между
    // запросами (и переживает рестарт процесса).
    const cached = await dailyStateFor(accountId, OWNER_TIMEZONE, new Date(), {
      userId: owner.id,
    });
    expect(cached?.can_claim).toBe(true);
    expect(oauth.signinStatus).toHaveBeenCalledTimes(1);

    // Состояние видно и по чужому вызову (страница, автосверка) — это общая БД.
    const stored = await readPanelStates(owner.id, OWNER_TIMEZONE, [accountId]);
    expect(stored.get(accountId)?.can_claim).toBe(true);
    expect((await dailyStates(owner.id, OWNER_TIMEZONE)).get(accountId)?.points).toBe(400);
  });

  it('клетка забрана — очков нет, отдавать аккаунт нельзя', async () => {
    const accountId = await makeAccountWithPair('burned@example.test');
    oauth.signinStatus.mockResolvedValue(panelResponse(false));

    const state = await dailyStateFor(accountId, DEFAULT_TIMEZONE, new Date(), {
      force: true,
      userId: owner.id,
    });
    expect(state?.can_claim).toBe(false);
  });

  it('панель не ответила — это «не знаю», а не «очков нет»', async () => {
    const accountId = await makeAccountWithPair('silent@example.test');
    oauth.signinStatus.mockResolvedValue({ ok: false, error: 'network' });

    const state = await dailyStateFor(accountId, OWNER_TIMEZONE, new Date(), {
      force: true,
      userId: owner.id,
    });
    expect(state).toBeNull();
    // И в БД ничего не записано: неизвестное состояние не должно выдавать себя
    // за прочитанное.
    expect((await readPanelStates(owner.id, OWNER_TIMEZONE, [accountId])).size).toBe(0);
  });

  it('пара токенов удалена — читать нечего', async () => {
    const accountId = await makeAccountWithPair('nopair@example.test');
    await refs.current!.delete(accountToken).where(eq(accountToken.accountId, accountId));

    const state = await dailyStateFor(accountId, OWNER_TIMEZONE, new Date(), {
      force: true,
      userId: owner.id,
    });
    expect(state).toBeNull();
    expect(oauth.signinStatus).not.toHaveBeenCalled();
  });

  it('протухшее состояние перечитывается, а не выдаётся за свежее', async () => {
    const accountId = await makeAccountWithPair('stale@example.test');
    oauth.signinStatus.mockResolvedValue(panelResponse(true));

    const now = new Date();
    await dailyStateFor(accountId, OWNER_TIMEZONE, now, { force: true, userId: owner.id });
    expect(oauth.signinStatus).toHaveBeenCalledTimes(1);

    // Через два часа состояние протухло (живёт полчаса) — читаем заново.
    const later = new Date(now.getTime() + 2 * 60 * 60_000);
    await dailyStateFor(accountId, OWNER_TIMEZONE, later, { userId: owner.id });
    expect(oauth.signinStatus).toHaveBeenCalledTimes(2);
  });
});

describe('сверка суток: автосверка', () => {
  it('свежая сверка обновляет только протухшее, force — всё', async () => {
    await makeAccountWithPair('sweep@example.test');
    oauth.signinStatus.mockResolvedValue(panelResponse(true));

    const now = new Date();
    const first = await syncDailyStates(owner.id, OWNER_TIMEZONE, now);
    expect(first.checked).toBe(1);
    expect(first.skipped).toBe(0);

    // Тот же момент: состояние свежее — вендор не дёргаем.
    const second = await syncDailyStates(owner.id, OWNER_TIMEZONE, now);
    expect(second.checked).toBe(0);
    expect(second.skipped).toBe(1);
    expect(oauth.signinStatus).toHaveBeenCalledTimes(1);

    // Кнопка владельца — «сверить сейчас»: перечитываем всё.
    const forced = await syncDailyStates(owner.id, OWNER_TIMEZONE, now, { force: true });
    expect(forced.checked).toBe(1);
    expect(oauth.signinStatus).toHaveBeenCalledTimes(2);
  });

  it('обход читает панель в обоих рабочих поясах и по всем владельцам', async () => {
    await makeAccountWithPair('sweep-two@example.test');
    oauth.signinStatus.mockResolvedValue(panelResponse(true));

    const result = await sweepPanelStates(new Date());
    expect(result.owners).toBe(1);
    // Один аккаунт × два пояса.
    expect(result.checked).toBe(2);
    expect(result.claimable).toBe(2);
    expect(result.failed).toBe(0);

    const stored = await readPanelStates(owner.id, OWNER_TIMEZONE);
    expect(stored.size).toBe(1);
    const storedUtc = await readPanelStates(owner.id, DEFAULT_TIMEZONE);
    expect(storedUtc.size).toBe(1);
  });

  it('состояние обновляется вдвое чаще срока годности — иначе пул скатывается на эвристику', async () => {
    // Порог обновления (15 мин) — вдвое меньше срока годности (30 мин). Если бы
    // автосверка обновляла по сроку годности, ответы подползали бы к границе:
    // сверка пропускала бы «ещё годное», а пул уже считал бы «не знаю» — и
    // аккаунты, которым панель вернула очки, выпадали бы из оборота.
    await makeAccountWithPair('refresh-age@example.test');
    oauth.signinStatus.mockResolvedValue(panelResponse(true));

    const now = new Date();
    await syncDailyStates(owner.id, OWNER_TIMEZONE, now, { force: true });
    expect(oauth.signinStatus).toHaveBeenCalledTimes(1);

    // Через 20 минут состояние ещё годное для пула (срок 30 мин), но для
    // автосверки уже «подпорченное» (порог 15 мин) — перечитываем.
    const later = new Date(now.getTime() + 20 * 60_000);
    const refreshed = await syncDailyStates(owner.id, OWNER_TIMEZONE, later, {
      maxAgeMs: PANEL_REFRESH_AGE_MS,
    });
    expect(refreshed.checked).toBe(1);
    expect(oauth.signinStatus).toHaveBeenCalledTimes(2);
  });
});

/**
 * Антиспам (заказ владельца 18.11): у вендора спрашиваем только там, где ответ
 * что-то меняет.
 *
 * Опрос панели по ВСЕМ аккаунтам стоил ≈21 000 обращений к MiniMax в сутки (228
 * состояний × 92 запуска) — риск блокировки. После утреннего забора бонусов
 * подавляющему большинству аккаунтов отвечать нечего: правда о них — в леджере.
 */
describe('антиспам: кого автосверка спрашивает у вендора', () => {
  const targets = { inWork: new Set([2]), claimedToday: new Set([1, 2, 3]) };

  it('забрали мы, по аккаунту никто не работает — не спрашиваем вовсе', () => {
    expect(panelSweepDecision(1, targets, new Date(), PANEL_REFRESH_AGE_MS)).toEqual({
      read: false,
    });
  });

  it('в работе — спрашиваем, но не чаще раза в час', () => {
    // 2026-11-18T12:00Z = 15:00 МСК — не ночное окно.
    const decision = panelSweepDecision(
      2,
      targets,
      new Date('2026-11-18T12:00:00Z'),
      PANEL_REFRESH_AGE_MS,
    );
    expect(decision).toEqual({ read: true, refreshAfterMs: PANEL_IN_WORK_REFRESH_MS });
  });

  it('в ночном окне 00:00–03:00 МСК — по обычному порогу: пояса расходятся', () => {
    // 2026-11-17T22:00Z = 01:00 МСК 18-го — ночное окно.
    const night = new Date('2026-11-17T22:00:00Z');
    expect(panelSweepDecision(2, targets, night, PANEL_REFRESH_AGE_MS)).toEqual({
      read: true,
      refreshAfterMs: PANEL_REFRESH_AGE_MS,
    });
  });

  it('забор не прошёл — по обычному порогу: очки могут появиться', () => {
    const empty = { inWork: new Set<number>(), claimedToday: new Set<number>() };
    expect(panelSweepDecision(9, empty, new Date(), PANEL_REFRESH_AGE_MS)).toEqual({
      read: true,
      refreshAfterMs: PANEL_REFRESH_AGE_MS,
    });
  });

  it('фокус собирается из БД: в работе — по журналу, забрали — по леджеру', async () => {
    const ours = await makeAccountWithPair('ours-focus@example.test');
    const busy = await makeAccountWithPair('busy-focus@example.test');
    const today = moscowToday(new Date());
    for (const accountId of [ours, busy]) {
      await refs.current!.insert(accountsDailyBonus).values({
        userId: owner.id,
        accountId,
        usedOn: today,
        dayNo: 3,
        points: 400,
        remaining: 400,
        status: 3,
        claimResult: 1,
      });
    }
    // Отдан потребителю сегодня — только этот аккаунт «в работе».
    await refs.current!.insert(accountsUsage).values({
      userId: owner.id,
      accountId: busy,
      usedOn: today,
      tokens: 400,
    });

    const targets = await panelSweepTargets(owner.id, new Date());
    expect(targets.claimedToday.has(ours)).toBe(true);
    expect(targets.inWork.has(ours)).toBe(false);
    expect(targets.inWork.has(busy)).toBe(true);
  });

  it('сквозным путём: мы забрали бонус сами и никто не работает — вендора не дёргаем', async () => {
    const accountId = await makeAccountWithPair('ours@example.test');
    await refs.current!.insert(accountsDailyBonus).values({
      userId: owner.id,
      accountId,
      usedOn: moscowToday(new Date()),
      dayNo: 3,
      points: 400,
      remaining: 400,
      status: 3,
      claimResult: 1,
    });
    oauth.signinStatus.mockResolvedValue(panelResponse(true));

    const result = await sweepPanelStates(new Date());
    // Ни в одном поясе не спросили (аккаунт один × два пояса).
    expect(result.notPolled).toBe(2);
    expect(result.checked).toBe(0);
    expect(oauth.signinStatus).not.toHaveBeenCalled();
  });

  it('сквозным путём: аккаунт в работе — спрашиваем, но не чаще раза в час', async () => {
    const accountId = await makeAccountWithPair('busy@example.test');
    await refs.current!.insert(accountsDailyBonus).values({
      userId: owner.id,
      accountId,
      usedOn: moscowToday(new Date()),
      dayNo: 3,
      points: 400,
      remaining: 400,
      status: 3,
      claimResult: 1,
    });
    await refs.current!.insert(accountsUsage).values({
      userId: owner.id,
      accountId,
      usedOn: moscowToday(new Date()),
      tokens: 400,
    });
    oauth.signinStatus.mockResolvedValue(panelResponse(true));

    const now = new Date();
    const first = await sweepPanelStates(now);
    expect(first.checked).toBe(2); // оба пояса
    expect(first.notPolled).toBe(0);
    expect(oauth.signinStatus).toHaveBeenCalledTimes(2);

    // Через 20 минут состояние ещё годное (порог для «в работе» — час) — не дёргаем.
    oauth.signinStatus.mockClear();
    const second = await sweepPanelStates(new Date(now.getTime() + 20 * 60_000));
    expect(second.checked).toBe(0);
    expect(oauth.signinStatus).not.toHaveBeenCalled();

    // Через час — перечитываем.
    const third = await sweepPanelStates(new Date(now.getTime() + 61 * 60_000));
    expect(third.checked).toBe(2);
  });

  it('кнопка владельца («сверить сейчас») спрашивает про всё — это его право', async () => {
    const accountId = await makeAccountWithPair('owner-button@example.test');
    await refs.current!.insert(accountsDailyBonus).values({
      userId: owner.id,
      accountId,
      usedOn: moscowToday(new Date()),
      dayNo: 3,
      points: 400,
      remaining: 400,
      status: 3,
      claimResult: 1,
    });
    oauth.signinStatus.mockResolvedValue(panelResponse(true));

    const result = await sweepPanelStates(new Date(), { force: true });
    expect(result.notPolled).toBe(0);
    expect(result.checked).toBe(2);
  });
});
