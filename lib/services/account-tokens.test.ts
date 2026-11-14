import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import { accountToken, accountsAccount } from '@/lib/db/schema';
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
}));

vi.mock('@/lib/minimax/oauth', () => ({
  startDeviceFlow: oauth.startDeviceFlow,
  exchangeDeviceCode: oauth.exchangeDeviceCode,
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
  acceptRefreshedPair,
  claimToken,
  handoverTokenPair,
  startNextTokenFlow,
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
    data: { accessToken: 'ACCESS-1', refreshToken: 'REFRESH-1', expiresInSeconds: 3600 },
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
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
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
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
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
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const progress = await tokenProgress(owner);
    expect(progress.total).toBe(2);
    expect(progress.withToken).toBe(1);
    expect(progress.remaining).toBe(1);
    expect(progress.complete).toBe(false);
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

describe('выдача пары проекту', () => {
  it('пара отдаётся ОДИН раз: refresh одноразовый', async () => {
    const accountId = await makeAccount('Выдаваемый', 'handover@example.test');
    const started = await startNextTokenFlow(owner);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await claimToken(owner, started.flow.flow_id);

    const first = await handoverTokenPair(accountId);
    expect(first?.access_token).toBe('ACCESS-1');
    expect(first?.refresh_token).toBe('REFRESH-1');
    expect(first?.expires_at_ms).toBeGreaterThan(Date.now());

    const second = await handoverTokenPair(accountId);
    expect(second).toBeNull();

    const progress = await tokenProgress(owner);
    expect(progress.rows.find((row) => row.account_id === accountId)?.state).toBe('handed_over');
  });

  it('обновлённая пара от проекта сохраняется — и отдаётся снова', async () => {
    const accountId = await makeAccount('Обновляемый', 'refresh@example.test');
    const started = await startNextTokenFlow(owner);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await claimToken(owner, started.flow.flow_id);
    await handoverTokenPair(accountId);
    expect(await handoverTokenPair(accountId)).toBeNull();

    const accepted = await acceptRefreshedPair(accountId, {
      accessToken: 'ACCESS-2',
      refreshToken: 'REFRESH-2',
    });
    expect(accepted).toBe(true);

    const again = await handoverTokenPair(accountId);
    expect(again?.access_token).toBe('ACCESS-2');
    expect(again?.refresh_token).toBe('REFRESH-2');
  });
});
