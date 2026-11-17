import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import { accountToken, accountsAccount, accountsUsage } from '@/lib/db/schema';
import { encryptSecret } from '@/lib/secrets/crypto';
import { moscowToday } from '@/lib/accounts/rotation';
import type { SessionUser } from '@/lib/auth/rbac';

/**
 * Гейт добычи токенов аккаунтов MiniMax (заказ владельца 14.11).
 *
 * Проверяем на настоящей схеме (pglite + наши миграции, включая 0032):
 * - «Следующий» берёт аккаунт БЕЗ токена и пропускает те, у которых токен уже есть;
 * - когда токены есть у всех — процесс останавливается («все токены получены»);
 * - пара кладётся в базу ШИФРОТЕКСТОМ (в строке нет открытого токена);
 * - пара отдаётся проекту ОДИН раз (refresh у MiniMax одноразовый);
 * - обновлённая пара, присланная проектом, сохраняется и снова отдаётся.
 */

const oauth = vi.hoisted(() => ({
  startDeviceFlow: vi.fn(),
  exchangeDeviceCode: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

vi.mock('@/lib/minimax/oauth', () => ({
  startDeviceFlow: oauth.startDeviceFlow,
  exchangeDeviceCode: oauth.exchangeDeviceCode,
  refreshAccessToken: oauth.refreshAccessToken,
  pkcePair: () => ({
    verifier: 'verifier-'.padEnd(43, 'x'),
    challenge: 'challenge-'.padEnd(43, 'y'),
  }),
  verificationLink: (uri: string, code: string) => `${uri}?user_code=${code}`,
}));

const refs = vi.hoisted(() => ({ current: undefined as TestDb | undefined }));
vi.mock('@/lib/db/client', () => ({
  get db() {
    return refs.current;
  },
}));

import {
  claimToken,
  ensureLiveAccessToken,
  markAccessHandedOver,
  startNextTokenFlow,
  tokenBackedAccountIds,
  tokenProgress,
} from '@/lib/services/account-tokens';

let pg: PGlite | undefined;

const owner: SessionUser = {
  id: 1,
  username: 'admin',
  email: '',
  firstName: '',
  lastName: '',
  isSuperuser: true,
};

async function makeAccount(title: string, email: string): Promise<number> {
  const [row] = await refs.current!
    .insert(accountsAccount)
    .values({
      userId: owner.id,
      title,
      email,
      passwordCt: '',
      passwordIv: '',
      passwordTag: '',
    })
    .returning({ id: accountsAccount.id });
  return row!.id;
}

beforeEach(async () => {
  process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
  const t = await createTestDb();
  pg = t.pg;
  refs.current = t.db;
  oauth.startDeviceFlow.mockReset();
  oauth.exchangeDeviceCode.mockReset();
  oauth.refreshAccessToken.mockReset();
  oauth.startDeviceFlow.mockResolvedValue({
    ok: true,
    data: {
      deviceCode: 'dev-code',
      userCode: 'ABCD-1234',
      verificationUri: 'https://account.minimax.io/oauth-authorize',
      verificationUriComplete: null,
      intervalSeconds: 5,
      expiresInSeconds: 600,
    },
  });
  oauth.exchangeDeviceCode.mockResolvedValue({
    ok: true,
    // Вендорский `expires_in` — 12 часов (43 200 с), как в проде. Фикстура в час
    // была неправдоподобной и, после правила «короткий access не отдаём»
    // (остаток < 2 ч — брак), ломала тесты на живую выдачу.
    data: { accessToken: 'ACCESS-1', refreshToken: 'REFRESH-1', expiresInSeconds: 43_200 },
  });
  // Refresh одноразовый, но вместе с новым access вендор отдаёт новый refresh —
  // цепочка продлевается (живая проба 15.11).
  oauth.refreshAccessToken.mockResolvedValue({
    ok: true,
    data: { accessToken: 'ACCESS-2', refreshToken: 'REFRESH-2', expiresInSeconds: 43_200 },
  });
});

afterEach(async () => {
  refs.current = undefined;
  await pg?.close();
  pg = undefined;
});

describe('добыча токенов: «Следующий»', () => {
  it('берёт аккаунт без токена и выдаёт ссылку подтверждения', async () => {
    const first = await makeAccount('Первый', 'first@example.test');
    const second = await makeAccount('Второй', 'second@example.test');

    const started = await startNextTokenFlow(owner);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.flow.account_id).toBe(first);
    expect(started.flow.user_code).toBe('ABCD-1234');
    expect(started.flow.verification_link).toContain('user_code=ABCD-1234');
    expect(started.flow.interval_seconds).toBe(5);

    // Второй аккаунт — уже следующий по кругу.
    const [flow] = await refs.current!
      .select()
      .from(accountToken)
      .where(eq(accountToken.accountId, first));
    expect(flow).toBeUndefined();
    expect(second).toBeGreaterThan(first);
  });

  it('аккаунт с уже добытым токеном пропускается', async () => {
    const withToken = await makeAccount('С токеном', 'token@example.test');
    const without = await makeAccount('Без токена', 'plain@example.test');
    await refs.current!.insert(accountToken).values({
      userId: owner.id,
      accountId: withToken,
      ciphertext: 'x',
      iv: 'x',
      authTag: 'x',
      expiresAt: new Date(Date.now() + 43_200_000).toISOString(),
    });

    const started = await startNextTokenFlow(owner);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.flow.account_id).toBe(without);
  });

  it('когда токены есть у всех — процесс останавливается', async () => {
    const only = await makeAccount('Единственный', 'only@example.test');
    await refs.current!.insert(accountToken).values({
      userId: owner.id,
      accountId: only,
      ciphertext: 'x',
      iv: 'x',
      authTag: 'x',
      expiresAt: new Date(Date.now() + 43_200_000).toISOString(),
    });

    const started = await startNextTokenFlow(owner);
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error).toBe('complete');
  });

  it('прогресс считает: есть, осталось, и «все получены»', async () => {
    const one = await makeAccount('Раз', 'one@example.test');
    await makeAccount('Два', 'two@example.test');
    await refs.current!.insert(accountToken).values({
      userId: owner.id,
      accountId: one,
      ciphertext: 'x',
      iv: 'x',
      authTag: 'x',
      expiresAt: new Date(Date.now() + 43_200_000).toISOString(),
    });

    const progress = await tokenProgress(owner);
    expect(progress.total).toBe(2);
    expect(progress.withToken).toBe(1);
    expect(progress.remaining).toBe(1);
    expect(progress.complete).toBe(false);
  });
});

describe('добыча токенов: кому пара пригодится сегодня', () => {
  /** Сегодняшний чек-ин: очки аккаунта уже сожжены — пара ему сегодня не нужна. */
  async function burnToday(accountId: number) {
    await refs.current!.insert(accountsUsage).values({
      userId: owner.id,
      accountId,
      usedOn: moscowToday(),
      tokens: 400,
      activationIndex: 1,
    });
  }

  it('«Следующий» берёт аккаунт, у которого очки сегодня ещё целы', async () => {
    const burned = await makeAccount('Сожжённый', 'burned@example.test');
    const fresh = await makeAccount('Свежий', 'fresh@example.test');
    await burnToday(burned);

    const started = await startNextTokenFlow(owner);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.flow.account_id).toBe(fresh);
  });

  it('если очки сегодня сожжены у всех — берём любого без токена (владелец идёт по кругу)', async () => {
    const only = await makeAccount('Единственный', 'only2@example.test');
    await burnToday(only);

    const started = await startNextTokenFlow(owner);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.flow.account_id).toBe(only);
  });

  it('прогресс показывает, чьи очки сегодня сожжены', async () => {
    const burned = await makeAccount('Сожжённый', 'burned2@example.test');
    const fresh = await makeAccount('Свежий', 'fresh2@example.test');
    await burnToday(burned);

    const progress = await tokenProgress(owner);
    // Отмеченный сегодня аккаунт НЕ свободен. Точный ярлык зависит от календаря:
    // в последний день недели недельная квота тоже исчерпана ('week_exhausted').
    expect(progress.rows.find((row) => row.account_id === burned)?.today_status).not.toBe('free');
    expect(progress.rows.find((row) => row.account_id === fresh)?.today_status).toBe('free');
  });

  it('добыча берёт четырёхсотовый аккаунт в первую очередь', async () => {
    // Мандат владельца 14.11: Сарафану — аккаунты на 400 очков, тысячные владелец
    // оставляет себе под программирование. Значит и ДОБЫВАТЬ (это подготовка для
    // Сарафана) надо сначала те, чья следующая активация даст 400.
    const daysAgo = (days: number) =>
      moscowToday(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
    // Три отметки подряд → следующая клетка 4 → 1000 очков (владельцу).
    const thousand = await makeAccount('Тысячник', 'thousand@example.test');
    await refs.current!.insert(accountsUsage).values([
      { userId: owner.id, accountId: thousand, usedOn: daysAgo(3), tokens: 400, activationIndex: 1 },
      { userId: owner.id, accountId: thousand, usedOn: daysAgo(2), tokens: 400, activationIndex: 2 },
      { userId: owner.id, accountId: thousand, usedOn: daysAgo(1), tokens: 400, activationIndex: 3 },
    ]);
    // Одна отметка → клетка 2 → 400 очков (Сарафану).
    const four = await makeAccount('Четырёхсотый', 'four@example.test');
    await refs.current!.insert(accountsUsage).values({
      userId: owner.id,
      accountId: four,
      usedOn: daysAgo(1),
      tokens: 400,
      activationIndex: 1,
    });

    const progress = await tokenProgress(owner);
    expect(progress.rows.find((row) => row.account_id === thousand)?.points_next).toBe(1000);
    expect(progress.rows.find((row) => row.account_id === four)?.points_next).toBe(400);

    const started = await startNextTokenFlow(owner);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.flow.account_id).toBe(four);
  });
});

describe('добыча токенов: протухший access — не «нужен новый вход»', () => {
  /** Пара в базе: шифротекстом, с просроченным access. */
  async function storePair(accountId: number, access: string, refresh: string, expired: boolean) {
    const enc = encryptSecret(
      JSON.stringify({ access, refresh }),
      `accounts:account:${accountId}:token`,
    );
    await refs.current!.insert(accountToken).values({
      userId: owner.id,
      accountId,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      expiresAt: new Date(Date.now() + (expired ? -3_600_000 : 43_200_000)).toISOString(),
    });
  }

  it('пара остаётся в обороте: статус «Токен получен», а доступ оживляется по refresh', async () => {
    // Мандат владельца 15.11: «токены не протухли, протухло их использование на эти
    // сутки». Access живёт 12 часов, но refresh одноразовый — и вместе с новым
    // access вендор отдаёт новый refresh, то есть цепочка продлевается.
    const accountId = await makeAccount('Протухший', 'dead@example.test');
    await storePair(accountId, 'ACCESS-OLD', 'REFRESH-1', true);

    // Статус ровно два: пара есть — «Токен получен», а не «протухла».
    const progress = await tokenProgress(owner);
    expect(progress.rows.find((row) => row.account_id === accountId)?.state).toBe('obtained');
    expect(progress.withToken).toBe(1);
    expect(progress.remaining).toBe(0);

    // В выдачу аккаунт годен: протухший access мы оживим по refresh.
    expect(await tokenBackedAccountIds()).toContain(accountId);

    // «Следующий» его НЕ берёт: добывать заново не нужно — цепочка жива.
    const started = await startNextTokenFlow(owner);
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error).toBe('complete');

    // А при выдаче access оживает: refresh одноразовый, но цепочку продлевает.
    const live = await ensureLiveAccessToken(accountId);
    expect(live?.access_token).toBe('ACCESS-2');
    // Refresh наружу не уходит: цепочка наша.
    expect(live).not.toHaveProperty('refresh_token');

    // В базе — новая пара целиком (и refresh тоже новый).
    const [row] = await refs.current!
      .select()
      .from(accountToken)
      .where(eq(accountToken.accountId, accountId));
    expect(row!.ciphertext).not.toContain('ACCESS-OLD');
  });

  it('оборванная цепочка — честно «без токена»: аккаунту нужен новый вход', async () => {
    const accountId = await makeAccount('Оборванный', 'broken@example.test');
    await storePair(accountId, 'ACCESS-OLD', 'REFRESH-1', true);
    oauth.refreshAccessToken.mockResolvedValue({ ok: false, error: 'invalid_grant' });

    expect(await ensureLiveAccessToken(accountId)).toBeNull();

    // Пара удалена — аккаунт снова «без токена», и «Следующий» его возьмёт.
    const progress = await tokenProgress(owner);
    expect(progress.rows.find((row) => row.account_id === accountId)?.state).toBe('none');
    const started = await startNextTokenFlow(owner);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.flow.account_id).toBe(accountId);
  });
});

describe('добыча токенов: обмен кода', () => {
  it('пара кладётся в базу шифротекстом', async () => {
    const accountId = await makeAccount('Подтверждённый', 'ok@example.test');
    const started = await startNextTokenFlow(owner);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const claimed = await claimToken(owner, started.flow.flow_id);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.account_id).toBe(accountId);

    const [row] = await refs.current!
      .select()
      .from(accountToken)
      .where(eq(accountToken.accountId, accountId));
    expect(row).toBeDefined();
    // В строке нет открытого токена — только шифротекст.
    expect(row!.ciphertext).not.toContain('ACCESS-1');
    expect(row!.ciphertext).not.toContain('REFRESH-1');
  });

  it('неподтверждённый код — «жди», а не поломка', async () => {
    await makeAccount('Ждущий', 'wait@example.test');
    oauth.exchangeDeviceCode.mockResolvedValue({
      ok: false,
      error: 'authorization_pending',
    });
    const started = await startNextTokenFlow(owner);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const claimed = await claimToken(owner, started.flow.flow_id);
    expect(claimed.ok).toBe(false);
    if (claimed.ok) return;
    expect(claimed.error).toBe('authorization_pending');
  });
});

describe('выдача токена проекту', () => {
  it('access отдаётся ОДИН раз: пара целиком не отдаётся (мандат владельца 14.11)', async () => {
    const accountId = await makeAccount('Выдаваемый', 'handover@example.test');
    const started = await startNextTokenFlow(owner);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await claimToken(owner, started.flow.flow_id);

    const first = await ensureLiveAccessToken(accountId);
    expect(first?.access_token).toBe('ACCESS-1');
    // Refresh наружу не уходит: мандат владельца — отдавать по одному токену.
    expect(first).not.toHaveProperty('refresh_token');
    expect(first?.expires_at_ms).toBeGreaterThan(Date.now());

    await markAccessHandedOver(accountId);
    // Второй раз тот же живой access не отдаём: вход у проекта уже есть, баланс
    // у аккаунта общий.
    expect(await ensureLiveAccessToken(accountId)).toBeNull();

    const progress = await tokenProgress(owner);
    expect(progress.rows.find((row) => row.account_id === accountId)?.state).toBe('obtained');
    expect(progress.rows.find((row) => row.account_id === accountId)?.handed_over_at).not.toBeNull();
  });

  it('протухший access отдаём после оживления: потребитель получает живой токен', async () => {
    const accountId = await makeAccount('Обновляемый', 'refresh@example.test');
    const started = await startNextTokenFlow(owner);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await claimToken(owner, started.flow.flow_id);

    // Access умер (12 часов), но цепочка жива: обновляем и отдаём новый.
    await refs.current!
      .update(accountToken)
      .set({ expiresAt: new Date(Date.now() - 3_600_000).toISOString() });
    const live = await ensureLiveAccessToken(accountId);
    expect(live?.access_token).toBe('ACCESS-2');
    expect(live).not.toHaveProperty('refresh_token');
  });
});
