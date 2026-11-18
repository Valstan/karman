import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import { accountToken, accountsAccount } from '@/lib/db/schema';
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
  timezoneForRoom,
} from '@/lib/services/minimax-daily';
import { readPanelStates } from '@/lib/accounts/panel-state';

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

