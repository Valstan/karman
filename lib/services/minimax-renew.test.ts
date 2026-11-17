import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import { accountToken, accountsAccount, accountsUsage, secretsAudit, secretsProject, secretsToken } from '@/lib/db/schema';
import { hashToken } from '@/lib/secrets/token';
import { decryptSecret, encryptSecret } from '@/lib/secrets/crypto';
import { accountPasswordAad } from '@/lib/services/accounts';
import {
  accountTokenAad,
  ensureLiveAccessToken,
  MIN_HANDOVER_ACCESS_LIFETIME_MS,
} from '@/lib/services/account-tokens';
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

/**
 * Пара токенов аккаунта — как её кладёт владелец через device-flow.
 *
 * `lifetimeMs` — сколько жизни осталось у access. По умолчанию 12 часов (вендорский
 * `expires_in`) — то есть «живой И полон». Короткий остаток (< 2 часов) — это отдельный
 * случай (находка Мозга 17.11), его задают явно.
 */
async function makeTokenPair(
  accountId: number,
  access = 'ACCESS-1',
  refresh = 'REFRESH-1',
  lifetimeMs = 12 * 3_600_000,
) {
  const enc = encryptSecret(JSON.stringify({ access, refresh }), accountTokenAad(accountId));
  await refs.current!.insert(accountToken).values({
    userId: OWNER_ID,
    accountId,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    authTag: enc.authTag,
    expiresAt: new Date(NOW.getTime() + lifetimeMs).toISOString(),
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
    // Вендорский `expires_in` — 12 часов (43 200 с), как в проде.
    data: { accessToken: 'ACCESS-2', refreshToken: 'REFRESH-2', expiresInSeconds: 43_200 },
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
  it('продление по почте отклоняется: аккаунт опознаётся только по id', async () => {
    // Уточнение владельца 17.11: по почте аккаунт не ищем — почта это способ
    // АВТОРИЗАЦИИ на сайте MiniMax (вход по коду с почты), а не способ опознать
    // аккаунт. id потребителю отдаём мы сами (в ответе выдачи).
    const accountId = await makeAccount('По почте', 'bypost@example.test');
    await makeCheckIn(accountId, '2026-11-16', 2);
    await makeTokenPair(accountId);
    await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    await expirePair(accountId, new Date(NOW.getTime() - 60_000));

    const result = await renewAccountAccess(
      ROOM_TOKEN,
      '127.0.0.1',
      { accountId: null },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(400);
    expect(result.error.error).toContain('account_id');
    // Цепочка не тронута.
    expect(oauth.refreshAccessToken).not.toHaveBeenCalled();
    const stored = await readPair(accountId);
    expect(stored.access).toBe('ACCESS-1');
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
      { accountId: 999_999 },
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
 * Порог остатка жизни access (находка Мозга 17.11, «access с остатком 9 минут»).
 *
 * Отдать потребителю почти мёртвый токен — значит угробить его вход и сжечь аккаунт
 * впустую (access одноразовый, вернуть его нельзя). Поэтому остаток меньше двух
 * часов — брак: и выдача, и продление цепочки в этом случае продлевают пару по
 * refresh, а не отдают доживающий токен.
 */
describe('короткий access не отдаём (находка Мозга 17.11)', () => {
  it('выдача: access с остатком 30 минут не отдаётся — цепочка продлена, наружу свежий', async () => {
    const accountId = await makeAccount('Короткий', 'short@example.test');
    await makeCheckIn(accountId, '2026-11-16', 2);
    await makeTokenPair(accountId, 'ACCESS-DYING', 'REFRESH-1', 30 * 60_000);

    const issued = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    // Наружу — НЕ тот токен, который доживает полчаса.
    expect(issued.offer.access_token).toBe('ACCESS-2');
    expect(issued.offer.expires_at_ms).toBe(NOW.getTime() + 43_200_000);
    expect(oauth.refreshAccessToken).toHaveBeenCalledTimes(1);
    // В базе — новая пара целиком.
    const stored = await readPair(accountId);
    expect(stored.access).toBe('ACCESS-2');
    expect(stored.refresh).toBe('REFRESH-2');
  });

  it('продление: остаток 30 минут — продлеваем цепочку, а не отдаём тот же', async () => {
    const accountId = await makeAccount('Короткий на продлении', 'short2@example.test');
    await makeCheckIn(accountId, '2026-11-16', 2);
    await makeTokenPair(accountId, 'ACCESS-DYING', 'REFRESH-1', 30 * 60_000);
    await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    oauth.refreshAccessToken.mockClear();
    oauth.refreshAccessToken.mockResolvedValue({
      ok: true,
      data: { accessToken: 'ACCESS-3', refreshToken: 'REFRESH-3', expiresInSeconds: 43_200 },
    });
    // Возвращаем «доживающий» остаток: выдача цепочку уже продлила.
    await expirePair(accountId, new Date(NOW.getTime() + 30 * 60_000));

    const result = await renewAccountAccess(ROOM_TOKEN, '127.0.0.1', { accountId }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.renewal.renewed).toBe(true);
    expect(result.renewal.access_token).toBe('ACCESS-3');
    expect(result.renewal.expires_at_ms).toBe(NOW.getTime() + 43_200_000);
    // Публичный контракт не меняем — сколько оставалось ДО продления, видно в аудите
    // (по этому и судим о браке в разборе выдач).
    const audits = await refs.current!
      .select({ detail: secretsAudit.detail })
      .from(secretsAudit)
      .where(eq(secretsAudit.action, 'minimax_account_renewed'));
    expect(audits.length).toBe(1);
    expect(audits[0]!.detail).toContain('оставалось 30 мин');
  });

  it('порог ровно в два часа: остаток на границе отдаём, цепочку не трогаем', async () => {
    const accountId = await makeAccount('На границе', 'edge@example.test');
    await makeCheckIn(accountId, '2026-11-16', 2);
    await makeTokenPair(accountId, 'ACCESS-EDGE', 'REFRESH-1', MIN_HANDOVER_ACCESS_LIFETIME_MS);

    const issued = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.offer.access_token).toBe('ACCESS-EDGE');
    expect(oauth.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('короткий остаток и оборванная цепочка: аккаунт негоден — отдаём следующего', async () => {
    const brokenId = await makeAccount('Короткий и оборванный', 'broken-short@example.test');
    await makeCheckIn(brokenId, '2026-11-16', 2);
    await makeTokenPair(brokenId, 'ACCESS-DYING', 'REFRESH-BROKEN', 30 * 60_000);
    oauth.refreshAccessToken.mockResolvedValue({ ok: false, error: 'invalid_grant' });

    // Аккаунт с коротким остатком и мёртвым refresh негоден — null, а не «токен с
    // остатком 30 минут».
    const handover = await ensureLiveAccessToken(brokenId, NOW);
    expect(handover).toBeNull();
    // Пара удалена: аккаунту нужен новый вход владельца, пул не должен предлагать его.
    expect(await readPair(brokenId)).toEqual({});
  });
});

/**
 * G54 — контракт проходит все слои целиком: тип → клиент → route-валидатор →
 * сервис → хранилище → обратное чтение.
 *
 * Правило G54 срабатывает, когда контракт расширяют через optional-поле: strict/
 * strip-схема молча срезает новое поле, и юнит-зелёный это НЕ ловит. Здесь поле
 * одно — «какой аккаунт» (`account_id`), и оно обязано дойти до сервиса и до БД.
 */
describe('G54: контракт продления проходит все слои', () => {
  it('схема принимает только id, а пустое тело или почта — нет', () => {
    expect(minimaxRenewSchema.safeParse({ account_id: 7 }).success).toBe(true);
    // Почта аккаунт не опознаёт (уточнение владельца 17.11): без id — отказ.
    expect(minimaxRenewSchema.safeParse({ email: 'a@b.test' }).success).toBe(false);
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

  it('поле доезжает до сервиса и до хранилища — и читается обратно', async () => {
    const accountId = await makeAccount('Контракт', 'contract@example.test');
    await makeCheckIn(accountId, '2026-11-16', 2);
    await makeTokenPair(accountId);
    await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    await expirePair(accountId, new Date(NOW.getTime() - 60_000));

    // Клиент шлёт то, что у него есть, — id из ответа выдачи.
    const parsed = minimaxRenewSchema.parse({ account_id: String(accountId) });
    expect(parsed.account_id).toBe(accountId);

    const result = await renewAccountAccess(
      ROOM_TOKEN,
      '127.0.0.1',
      { accountId: parsed.account_id ?? null },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.renewal.account_id).toBe(accountId);

    // Цепочка продлена — и это видно в хранилище (обратное чтение).
    const stored = await readPair(accountId);
    expect(stored.access).toBe('ACCESS-2');
    expect(stored.refresh).toBe('REFRESH-2');
  });

  it('негативный контроль: снятие поля из схемы роняет гейт', () => {
    // Если бы `account_id` убрали из схемы, значение молча пропало бы (zod срезает
    // неизвестные ключи) — и до сервиса не дошло бы: ровно тот класс дефекта,
    // который ловит G54. Наша схема поле сохраняет.
    const schemaWithoutId = z.object({
      email: z.string().trim().min(3).max(320).optional(),
    });
    const stripped = schemaWithoutId.parse({ account_id: 7 });
    expect(stripped).toEqual({});
    expect('account_id' in stripped).toBe(false);
    expect(minimaxRenewSchema.parse({ account_id: 7 }).account_id).toBe(7);
  });
});
