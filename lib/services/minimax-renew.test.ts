import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import { accountToken, accountsAccount, accountsUsage, secretsProject, secretsToken } from '@/lib/db/schema';
import { hashToken } from '@/lib/secrets/token';
import { decryptSecret, encryptSecret } from '@/lib/secrets/crypto';
import { accountPasswordAad } from '@/lib/services/accounts';
import { accountTokenAad } from '@/lib/services/account-tokens';
import { issueAccount, renewAccountAccess } from '@/lib/services/minimax';
import { minimaxRenewSchema } from '@/lib/validation/account';

/**
 * Гейт продления цепочки MiniMax (D-219, мандат владельца 17.11).
 *
 * Мозг: «продлевайте цепочку у себя и отдавайте нам свежий вход того же аккаунта —
 * пара нам не уходит, граница D-219 цела». Значит ручка `POST /api/minimax/renew`
 * должна:
 *
 * - отдать **свежий access** того же аккаунта, к которому потребитель уже имеет
 *   доступ (access протух → цепочка продлевается по refresh);
 * - **не отдать refresh никогда** — цепочка одноразовых refresh'ей наша;
 * - **не отдать чужой аккаунт**: продлить может только та комната, которой мы этот
 *   аккаунт выдали (один аккаунт — один потребитель, G627);
 * - **не трогать активацию** — клетка и номинал в докладе активации не меняются;
 * - честно сказать, когда продление невозможно (цепочка оборвана → нужен новый
 *   вход владельца).
 *
 * Проверяется на настоящей схеме (pglite + наши миграции), сквозным путём:
 * токен комнаты → выдача аккаунта → продление → пара в базе.
 */

const refs = vi.hoisted(() => ({ current: undefined as TestDb | undefined }));
vi.mock('@/lib/db/client', () => ({
  get db() {
    return refs.current;
  },
}));

// Refresh одноразовый, но цепочку продлевает: при протухшем access мы обновляем
// пару сами (мандат владельца 15.11 — «токены не протухли»).
const oauth = vi.hoisted(() => ({ refreshAccessToken: vi.fn(), signinStatus: vi.fn() }));
vi.mock('@/lib/minimax/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/minimax/oauth')>();
  return { ...actual, refreshAccessToken: oauth.refreshAccessToken, signinStatus: oauth.signinStatus };
});

let pg: PGlite | undefined;

const OWNER_ID = 1; // admin из scripts/bootstrap.sql
const ROOM_TOKEN = 'skm_test_room_token_0123456789abcdef';
const OTHER_ROOM_TOKEN = 'skm_test_other_room_token_0123456789';
const PASSWORD = 'пароль-из-vault';
const NOW = new Date('2026-11-17T12:00:00Z'); // 15:00 по Москве
const TODAY = '2026-11-17';

/** Комната с пишущим токеном. */
async function makeRoom(slug: string, name: string, token: string, canWrite = true) {
  const [room] = await refs.current!
    .insert(secretsProject)
    .values({ userId: OWNER_ID, name, slug })
    .returning({ id: secretsProject.id });
  await refs.current!.insert(secretsToken).values({
    projectId: room!.id,
    name: canWrite ? 'rw' : 'ro',
    tokenPrefix: token.slice(0, 12),
    tokenHash: hashToken(token),
    canWrite,
  });
  return room!.id;
}

/** Аккаунт пула с зашифрованным паролем. */
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
  const enc = encryptSecret(PASSWORD, accountPasswordAad(row!.id));
  await refs.current!
    .update(accountsAccount)
    .set({ passwordCt: enc.ciphertext, passwordIv: enc.iv, passwordTag: enc.authTag })
    .where(eq(accountsAccount.id, row!.id));
  return row!.id;
}

/** Отметка журнала: так аккаунт получает серию дней и клетку. */
async function makeCheckIn(accountId: number, usedOn: string, activationIndex: number) {
  await refs.current!.insert(accountsUsage).values({
    userId: OWNER_ID,
    accountId,
    usedOn,
    tokens: 400,
    activationIndex,
  });
}

/** Пара токенов аккаунта — как её кладёт владелец через device-flow. */
async function makeTokenPair(accountId: number, access = 'ACCESS-1', refresh = 'REFRESH-1') {
  const enc = encryptSecret(JSON.stringify({ access, refresh }), accountTokenAad(accountId));
  await refs.current!.insert(accountToken).values({
    userId: OWNER_ID,
    accountId,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    authTag: enc.authTag,
    expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
  });
}

/** Пара, протухшая раньше указанного момента. */
async function expirePair(accountId: number, at: Date) {
  await refs.current!
    .update(accountToken)
    .set({ expiresAt: at.toISOString() })
    .where(eq(accountToken.accountId, accountId));
}

/** Пара в базе — как её читает следующий, кто полезет в цепочку. */
async function readPair(accountId: number): Promise<{ access?: string; refresh?: string }> {
  const [row] = await refs.current!
    .select()
    .from(accountToken)
    .where(eq(accountToken.accountId, accountId))
    .limit(1);
  if (!row) return {};
  return JSON.parse(
    decryptSecret(
      { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag },
      accountTokenAad(accountId),
    ),
  ) as { access?: string; refresh?: string };
}

/** Ответ панели MiniMax: сегодняшняя клетка забираема, очки — сколько скажем. */
function panelAnswer(points = 400) {
  return {
    ok: true as const,
    data: {
      days: [{ day_no: 2, status: 2, points, is_today: true }],
      today: { day_no: 2, status: 2, points, is_today: true },
      canClaim: true,
      points,
    },
  };
}

beforeEach(async () => {
  process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
  const t = await createTestDb();
  pg = t.pg;
  refs.current = t.db;
  await makeRoom('setka', 'SARAFAN', ROOM_TOKEN);
  oauth.refreshAccessToken.mockReset();
  oauth.refreshAccessToken.mockResolvedValue({
    ok: true,
    data: { accessToken: 'ACCESS-2', refreshToken: 'REFRESH-2', expiresInSeconds: 3600 },
  });
  oauth.signinStatus.mockReset();
  oauth.signinStatus.mockResolvedValue(panelAnswer());
});

afterEach(async () => {
  refs.current = undefined;
  await pg?.close();
  pg = undefined;
});

describe('продление цепочки MiniMax (D-219)', () => {
  it('протухший access продлевается: наружу свежий access, refresh остаётся у нас', async () => {
    const accountId = await makeAccount('Продлеваемый', 'renew@example.test');
    await makeCheckIn(accountId, '2026-11-16', 2);
    await makeTokenPair(accountId);
    // Выдали аккаунт комнате — он теперь её (used_project_id).
    const issued = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.offer.account?.id).toBe(accountId);

    // Access протух (вендорские 12 часов прошли).
    await expirePair(accountId, new Date(NOW.getTime() - 60_000));

    const result = await renewAccountAccess(ROOM_TOKEN, '127.0.0.1', { accountId }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.renewal.renewed).toBe(true);
    expect(result.renewal.access_token).toBe('ACCESS-2');
    expect(result.renewal.expires_at_ms).toBeGreaterThan(NOW.getTime());
    expect(result.renewal.account_id).toBe(accountId);
    expect(result.renewal.email).toBe('renew@example.test');
    // Мандат владельца 14.11 / D-219: пара наружу не уходит НИКОГДА.
    expect(result.renewal).not.toHaveProperty('refresh_token');
    expect((result.renewal as { refresh_token?: string }).refresh_token).toBeUndefined();

    // Цепочка продлена в базе: новая пара целиком, refresh — новый.
    const stored = await readPair(accountId);
    expect(stored.access).toBe('ACCESS-2');
    expect(stored.refresh).toBe('REFRESH-2');
  });

  it('живой access отдаётся тот же — refresh не жежём зря', async () => {
    const accountId = await makeAccount('Живой', 'alive@example.test');
    await makeCheckIn(accountId, '2026-11-16', 2);
    await makeTokenPair(accountId, 'ACCESS-LIVE');
    const issued = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(issued.ok).toBe(true);

    const result = await renewAccountAccess(ROOM_TOKEN, '127.0.0.1', { accountId }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.renewal.renewed).toBe(false);
    expect(result.renewal.access_token).toBe('ACCESS-LIVE');
    // Refresh не тронут: пара в базе та же.
    expect(oauth.refreshAccessToken).not.toHaveBeenCalled();
    const stored = await readPair(accountId);
    expect(stored.access).toBe('ACCESS-LIVE');
    expect(stored.refresh).toBe('REFRESH-1');
  });

  it('продление по почте — тот же аккаунт (проект не обязан знать наши id)', async () => {
    const accountId = await makeAccount('По почте', 'bypost@example.test');
    await makeCheckIn(accountId, '2026-11-16', 2);
    await makeTokenPair(accountId);
    await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    await expirePair(accountId, new Date(NOW.getTime() - 60_000));

    const result = await renewAccountAccess(
      ROOM_TOKEN,
      '127.0.0.1',
      { email: 'bypost@example.test' },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.renewal.account_id).toBe(accountId);
    expect(result.renewal.access_token).toBe('ACCESS-2');
  });

  it('чужая комната аккаунт не продлевает (один аккаунт — один потребитель)', async () => {
    const accountId = await makeAccount('Чужой', 'alien@example.test');
    await makeCheckIn(accountId, '2026-11-16', 2);
    await makeTokenPair(accountId);
    await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    await expirePair(accountId, new Date(NOW.getTime() - 60_000));

    await makeRoom('gonba', 'GONBA', OTHER_ROOM_TOKEN);
    const result = await renewAccountAccess(
      OTHER_ROOM_TOKEN,
      '127.0.0.1',
      { accountId },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(409);
    // Цепочка не тронута: чужой запрос refresh не крутил.
    expect(oauth.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('аккаунт, который мы этой комнате не выдавали, продлить нельзя', async () => {
    const accountId = await makeAccount('Не наш', 'notours@example.test');
    await makeTokenPair(accountId);

    const result = await renewAccountAccess(ROOM_TOKEN, '127.0.0.1', { accountId }, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(409);
  });

  it('оборванная цепочка — честный отказ: нужен новый вход владельца', async () => {
    const accountId = await makeAccount('Оборван', 'broken@example.test');
    await makeCheckIn(accountId, '2026-11-16', 2);
    await makeTokenPair(accountId);
    await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    await expirePair(accountId, new Date(NOW.getTime() - 60_000));
    // Вендор refresh больше не принимает — цепочка оборвана.
    oauth.refreshAccessToken.mockResolvedValue({ ok: false, error: 'invalid_grant' });

    const result = await renewAccountAccess(ROOM_TOKEN, '127.0.0.1', { accountId }, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(409);
    expect(result.error.error).toContain('оборвана');
  });

  it('read-only токен продление не получает', async () => {
    const roToken = 'skm_test_readonly_token_0123456789abcd';
    await makeRoom('ro-room', 'RO', roToken, false);
    const result = await renewAccountAccess(roToken, '127.0.0.1', { accountId: 1 }, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(403);
  });

  it('неизвестный аккаунт — 404, а не пустой ответ', async () => {
    const result = await renewAccountAccess(
      ROOM_TOKEN,
      '127.0.0.1',
      { email: 'nobody@example.test' },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(404);
  });

  it('продление не трогает активацию: клетка и очки в журнале те же', async () => {
    const accountId = await makeAccount('Учёт', 'accounting@example.test');
    await makeCheckIn(accountId, '2026-11-16', 2);
    await makeTokenPair(accountId);
    await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    await expirePair(accountId, new Date(NOW.getTime() - 60_000));

    const before = await refs.current!
      .select()
      .from(accountsUsage)
      .where(and(eq(accountsUsage.accountId, accountId), eq(accountsUsage.usedOn, TODAY)));
    expect(before).toHaveLength(1);

    const result = await renewAccountAccess(ROOM_TOKEN, '127.0.0.1', { accountId }, NOW);
    expect(result.ok).toBe(true);

    const after = await refs.current!
      .select()
      .from(accountsUsage)
      .where(and(eq(accountsUsage.accountId, accountId), eq(accountsUsage.usedOn, TODAY)));
    expect(after).toHaveLength(1);
    expect(after[0]!.tokens).toBe(before[0]!.tokens);
    expect(after[0]!.activationIndex).toBe(before[0]!.activationIndex);
    expect(after[0]!.projectId).toBe(before[0]!.projectId);
  });
});

/**
 * G54 — контракт проходит все слои целиком: тип → клиент → route-валидатор →
 * сервис → хранилище → обратное чтение.
 *
 * Правило G54 срабатывает, когда контракт расширяют через optional-поле: strict/
 * strip-схема молча срезает новое поле, и юнит-зелёный это НЕ ловит. Здесь поле
 * одно — «какой аккаунт» (id или почта), и оно обязано дойти до сервиса и до БД.
 */
describe('G54: контракт продления проходит все слои', () => {
  it('схема принимает id и почту, а пустое тело — нет', () => {
    expect(minimaxRenewSchema.safeParse({ account_id: 7 }).success).toBe(true);
    expect(minimaxRenewSchema.safeParse({ email: 'a@b.test' }).success).toBe(true);
    const empty = minimaxRenewSchema.safeParse({});
    expect(empty.success).toBe(false);
    // Не целое / не положительное — мимо.
    expect(minimaxRenewSchema.safeParse({ account_id: 0 }).success).toBe(false);
    expect(minimaxRenewSchema.safeParse({ account_id: -1 }).success).toBe(false);
    expect(minimaxRenewSchema.safeParse({ account_id: 1.5 }).success).toBe(false);
  });

  it('id из строки приводится к числу, неизвестное поле срезается', () => {
    const parsed = minimaxRenewSchema.parse({ account_id: '42', refresh_token: 'подсунуть' });
    expect(parsed.account_id).toBe(42);
    // Чужое поле (в т.ч. попытка подсунуть пару) в сервис не доходит.
    expect(parsed).not.toHaveProperty('refresh_token');
  });

  it('поле доезжает до сервиса: по id и по почте — один и тот же аккаунт', async () => {
    const accountId = await makeAccount('Контракт', 'contract@example.test');
    await makeCheckIn(accountId, '2026-11-16', 2);
    await makeTokenPair(accountId);
    await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    await expirePair(accountId, new Date(NOW.getTime() - 60_000));

    // Клиент шлёт то, что у него есть, — и получает доступ к нужному аккаунту.
    const byId = minimaxRenewSchema.parse({ account_id: String(accountId) });
    const byMail = minimaxRenewSchema.parse({ email: 'contract@example.test' });

    const first = await renewAccountAccess(
      ROOM_TOKEN,
      '127.0.0.1',
      { accountId: byId.account_id ?? null, email: byId.email ?? null },
      NOW,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.renewal.account_id).toBe(accountId);

    // Тот же аккаунт по почте — второй путь через ту же схему.
    const second = await renewAccountAccess(
      ROOM_TOKEN,
      '127.0.0.1',
      { accountId: byMail.account_id ?? null, email: byMail.email ?? null },
      NOW,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.renewal.account_id).toBe(accountId);

    // Цепочка продлена — и это видно в хранилище (обратное чтение).
    const stored = await readPair(accountId);
    expect(stored.access).toBe('ACCESS-2');
    expect(stored.refresh).toBe('REFRESH-2');
  });

  it('негативный контроль: снятие поля из схемы роняет гейт', () => {
    // Если бы `email` убрали из схемы, значение молча пропало бы (zod срезает
    // неизвестные ключи) — и до сервиса не дошло бы: ровно тот класс дефекта,
    // который ловит G54. Наша схема поле сохраняет.
    const schemaWithoutEmail = z.object({
      account_id: z.coerce.number().int().positive().optional(),
    });
    const stripped = schemaWithoutEmail.parse({ email: 'a@b.test' });
    expect(stripped).toEqual({});
    expect('email' in stripped).toBe(false);
    expect(minimaxRenewSchema.parse({ email: 'a@b.test' }).email).toBe('a@b.test');
  });
});
