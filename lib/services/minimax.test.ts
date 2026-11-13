import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import {
  accountsAccount,
  accountsProject,
  accountsUsage,
  secretsProject,
  secretsToken,
} from '@/lib/db/schema';
import { hashToken } from '@/lib/secrets/token';
import { encryptSecret } from '@/lib/secrets/crypto';
import { accountPasswordAad } from '@/lib/services/accounts';
import { issueAccount, recordActivation } from '@/lib/services/minimax';

/**
 * Гейт машинного доступа к пулу MiniMax (заказ владельца 13.11).
 *
 * Проверяется на настоящей схеме (pglite + наши миграции), сквозным путём:
 * токен комнаты → раздача аккаунта → запись активации → журнал.
 *
 * Что здесь закрыто:
 * - **раздача отдаёт 400-очковый аккаунт**, даже когда рядом есть тысячник
 *   (тысячные владелец оставляет себе под программирование);
 * - **пароль доезжает** до проекта расшифрованным (иначе проект не активирует);
 * - **запись идёт тем же путём, что и кнопка владельца**: строка журнала на сегодня,
 *   очки по клетке, проект = комната;
 * - **повтор от другого проекта — 409** (одна правда об аккаунте в сутки);
 * - **повтор от того же проекта — обновление**, а не вторая строка.
 */

const refs = vi.hoisted(() => ({ current: undefined as TestDb | undefined }));
vi.mock('@/lib/db/client', () => ({
  get db() {
    return refs.current;
  },
}));

let pg: PGlite | undefined;

const OWNER_ID = 1; // admin из scripts/bootstrap.sql
const ROOM_TOKEN = 'skm_test_room_token_0123456789abcdef';
const OTHER_ROOM_TOKEN = 'skm_test_other_room_token_0123456789';
const PASSWORD = 'пароль-из-vault';
const NOW = new Date('2026-11-13T12:00:00Z'); // 15:00 по Москве
const TODAY = '2026-11-13';

/** Комната с пишущим токеном. */
async function makeRoom(slug: string, name: string, token: string) {
  const [room] = await refs.current!
    .insert(secretsProject)
    .values({ userId: OWNER_ID, name, slug })
    .returning({ id: secretsProject.id });
  await refs.current!.insert(secretsToken).values({
    projectId: room!.id,
    name: 'rw',
    tokenPrefix: token.slice(0, 12),
    tokenHash: hashToken(token),
    canWrite: true,
  });
  return room!.id;
}

/** Аккаунт пула с зашифрованным паролем. */
async function makeAccount(title: string, email: string, usedOn: string | null, usedAt: Date | null) {
  const [row] = await refs.current!
    .insert(accountsAccount)
    .values({
      userId: OWNER_ID,
      title,
      email,
      passwordCt: '',
      passwordIv: '',
      passwordTag: '',
      usedOn,
      usedAt: usedAt ? usedAt.toISOString() : null,
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

// Свежая схема на каждый кейс: пул общий, и один кейс не должен видеть аккаунты
// другого (иначе «тысячник отдаётся, когда четырёхсотых нет» ловит чужой аккаунт).
// Комната Сарафана с пишущим токеном — на каждый кейс своя.
beforeEach(async () => {
  process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
  const t = await createTestDb();
  pg = t.pg;
  refs.current = t.db;
  await makeRoom('setka', 'SARAFAN', ROOM_TOKEN);
});

afterEach(async () => {
  refs.current = undefined;
  await pg?.close();
  pg = undefined;
});

describe('пул MiniMax: раздача аккаунта проекту', () => {
  it('отдаёт аккаунт на 400 очков, а тысячник оставляет владельцу', async () => {
    // Два аккаунта: у одного серия даст сегодня 1000, у другого — 400.
    const thousand = await makeAccount('Тысячник', 'thousand@example.test', null, null);
    const four = await makeAccount('Обычный', 'four@example.test', null, null);
    // Клетка 4 → 1000 очков: три отметки подряд (10, 11, 12 → сегодня 4-я).
    await makeCheckIn(thousand, '2026-11-10', 1);
    await makeCheckIn(thousand, '2026-11-11', 2);
    await makeCheckIn(thousand, '2026-11-12', 3);
    await makeCheckIn(four, '2026-11-12', 2);

    const result = await issueAccount(ROOM_TOKEN, '127.0.0.1', NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offer.account?.id).toBe(four);
    expect(result.offer.tier).toBe('points_400');
    expect(result.offer.account?.points_next).toBe(400);
    // Пароль доезжает расшифрованным — иначе проект не сможет активировать аккаунт.
    expect(result.offer.account?.password).toBe(PASSWORD);
    expect(result.offer.account?.email).toBe('four@example.test');
  });

  it('тысячник отдаётся, когда свободных четырёхсотых не осталось', async () => {
    await makeRoom('gonba', 'GONBA', OTHER_ROOM_TOKEN);
    const thousand = await makeAccount('Тысячник2', 'thousand2@example.test', null, null);
    await makeCheckIn(thousand, '2026-11-10', 1);
    await makeCheckIn(thousand, '2026-11-11', 2);
    await makeCheckIn(thousand, '2026-11-12', 3);

    const result = await issueAccount(OTHER_ROOM_TOKEN, '127.0.0.1', NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offer.account?.id).toBe(thousand);
    expect(result.offer.tier).toBe('points_1000');
    expect(result.offer.account?.points_next).toBe(1000);
  });

  it('read-only токен не получает аккаунт', async () => {
    const [room] = await refs.current!
      .insert(secretsProject)
      .values({ userId: OWNER_ID, name: 'RO', slug: 'ro-room' })
      .returning({ id: secretsProject.id });
    const roToken = 'skm_test_readonly_token_0123456789abcd';
    await refs.current!.insert(secretsToken).values({
      projectId: room!.id,
      name: 'ro',
      tokenPrefix: roToken.slice(0, 12),
      tokenHash: hashToken(roToken),
      canWrite: false,
    });
    const result = await issueAccount(roToken, '127.0.0.1', NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(403);
  });
});

describe('пул MiniMax: запись активации', () => {
  it('пишет журнал: день, очки по клетке, проект = комната', async () => {
    const accountId = await makeAccount('Для записи', 'write@example.test', null, null);
    await makeCheckIn(accountId, '2026-11-12', 2);

    const result = await recordActivation(
      ROOM_TOKEN,
      '127.0.0.1',
      { accountId, points: null, activationIndex: null },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.used_on).toBe(TODAY);
    // Серия 1 → клетка 2 → 400 очков.
    expect(result.record.activation_index).toBe(2);
    expect(result.record.points).toBe(400);
    expect(result.record.updated).toBe(false);

    const [row] = await refs.current!
      .select()
      .from(accountsUsage)
      .where(and(eq(accountsUsage.accountId, accountId), eq(accountsUsage.usedOn, TODAY)));
    expect(row!.usedOn).toBe(TODAY);
    expect(row!.tokens).toBe(400);
    const [project] = await refs.current!
      .select()
      .from(accountsProject)
      .where(eq(accountsProject.id, row!.projectId!));
    expect(project!.name).toBe('SARAFAN');
  });

  it('номер клетки от проекта — истина, расхождение помечается', async () => {
    const accountId = await makeAccount('С показанием', 'signal@example.test', null, null);
    await makeCheckIn(accountId, '2026-11-12', 2);

    const result = await recordActivation(
      ROOM_TOKEN,
      '127.0.0.1',
      { accountId, points: null, activationIndex: 4 },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Проект увидел на панели 4-ю клетку → 1000 очков; мы ждали 2-ю → расхождение.
    expect(result.record.activation_index).toBe(4);
    expect(result.record.points).toBe(1000);
    expect(result.record.mismatch).toBe(true);
    expect(result.record.source).toBe('client_index');
  });

  it('повтор от другого проекта — 409: одна правда об аккаунте в сутки', async () => {
    await makeRoom('gonba', 'GONBA', OTHER_ROOM_TOKEN);
    const accountId = await makeAccount('Гонка', 'race@example.test', null, null);
    const first = await recordActivation(
      ROOM_TOKEN,
      '127.0.0.1',
      { accountId, points: null, activationIndex: null },
      NOW,
    );
    expect(first.ok).toBe(true);

    const second = await recordActivation(
      OTHER_ROOM_TOKEN,
      '127.0.0.1',
      { accountId, points: null, activationIndex: null },
      NOW,
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.status).toBe(409);
  });

  it('повтор от того же проекта — обновление, а не вторая строка', async () => {
    const accountId = await makeAccount('Повтор', 'retry@example.test', null, null);
    await makeCheckIn(accountId, '2026-11-12', 2);
    await recordActivation(ROOM_TOKEN, '127.0.0.1', { accountId, points: null, activationIndex: null }, NOW);
    const again = await recordActivation(
      ROOM_TOKEN,
      '127.0.0.1',
      { accountId, points: 1000, activationIndex: null },
      NOW,
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.record.updated).toBe(true);

    const rows = await refs.current!
      .select()
      .from(accountsUsage)
      .where(eq(accountsUsage.accountId, accountId));
    const today = rows.filter((row) => row.usedOn === TODAY);
    expect(today).toHaveLength(1);
    expect(today[0]!.tokens).toBe(1000);
  });
});
