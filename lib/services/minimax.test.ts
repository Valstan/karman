import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import {
  accountsAccount,
  accountsProject,
  accountsUsage,
  accountToken,
  secretsProject,
  secretsToken,
} from '@/lib/db/schema';
import { hashToken } from '@/lib/secrets/token';
import { encryptSecret } from '@/lib/secrets/crypto';
import { accountPasswordAad } from '@/lib/services/accounts';
import { accountTokenAad } from '@/lib/services/account-tokens';
import { issueAccount, recordObservation } from '@/lib/services/minimax';

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

/**
 * Пара токенов аккаунта — как её кладёт владелец через device-flow.
 * Без неё ручка `available` аккаунт не отдаёт: вход в MiniMax делает владелец,
 * у проекта пароля нет.
 */
async function makeTokenPair(accountId: number, access = 'ACCESS-1', refresh = 'REFRESH-1') {
  const enc = encryptSecret(
    JSON.stringify({ access, refresh }),
    accountTokenAad(accountId),
  );
  await refs.current!.insert(accountToken).values({
    userId: OWNER_ID,
    accountId,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    authTag: enc.authTag,
    expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
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
    await makeTokenPair(thousand);
    await makeTokenPair(four);

    const result = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offer.account?.id).toBe(four);
    expect(result.offer.tier).toBe('points_400');
    expect(result.offer.account?.points_next).toBe(400);
    expect(result.offer.account?.email).toBe('four@example.test');
    // Пароля в ответе нет: Сарафан работает по почте, секрет наружу не выносим.
    expect('password' in (result.offer.account ?? {})).toBe(false);
  });

  it('тысячник отдаётся, когда свободных четырёхсотых не осталось', async () => {
    await makeRoom('gonba', 'GONBA', OTHER_ROOM_TOKEN);
    const thousand = await makeAccount('Тысячник2', 'thousand2@example.test', null, null);
    await makeCheckIn(thousand, '2026-11-10', 1);
    await makeCheckIn(thousand, '2026-11-11', 2);
    await makeCheckIn(thousand, '2026-11-12', 3);
    await makeTokenPair(thousand);

    const result = await issueAccount(OTHER_ROOM_TOKEN, '127.0.0.1', {}, NOW);
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
    const result = await issueAccount(roToken, '127.0.0.1', {}, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(403);
  });

  it('exclude — проект может пропустить неподошедший аккаунт', async () => {
    const first = await makeAccount('Первый', 'first@example.test', null, null);
    const second = await makeAccount('Второй', 'second@example.test', null, null);
    await makeCheckIn(first, '2026-11-12', 2);
    await makeCheckIn(second, '2026-11-12', 2);
    await makeTokenPair(first);
    await makeTokenPair(second);

    const result = await issueAccount(ROOM_TOKEN, '127.0.0.1', { excludeIds: [first] }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offer.account?.id).toBe(second);
  });

  it('emails — проект получает только аккаунты из своего списка почт', async () => {
    const mine = await makeAccount('Мой', 'mine@example.test', null, null);
    const alien = await makeAccount('Чужой', 'alien@example.test', null, null);
    await makeCheckIn(mine, '2026-11-12', 2);
    await makeCheckIn(alien, '2026-11-12', 2);
    await makeTokenPair(mine);
    await makeTokenPair(alien);

    const result = await issueAccount(ROOM_TOKEN, '127.0.0.1', { emails: ['mine@example.test'] }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offer.account?.id).toBe(mine);
  });

  it('access едет вместе с аккаунтом — и только один раз, без refresh', async () => {
    const accountId = await makeAccount('С токеном', 'withtoken@example.test', null, null);
    await makeCheckIn(accountId, '2026-11-12', 2);
    await makeTokenPair(accountId);

    const first = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.offer.access_token).toBe('ACCESS-1');
    expect(first.offer.expires_at_ms).toBeGreaterThan(NOW.getTime());
    // Мандат владельца 14.11: пара целиком не отдаётся — только один токен.
    expect(first.offer).not.toHaveProperty('refresh_token');
    expect((first.offer as { refresh_token?: string }).refresh_token).toBeUndefined();

    // Access отдан — второй раз не отдаётся.
    const second = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.offer.access_token).toBeUndefined();
  });

  it('выдача САМА пишет активацию — проект ничего отправлять не должен', async () => {
    // Мандат владельца 14.11: «Сарафан не должен сам записывать активацию нам в
    // карман… ты сам его гасишь, и сам их ротируешь, и в статистику добавляешь».
    const accountId = await makeAccount('Выдаваемый', 'issued@example.test', null, null);
    await makeCheckIn(accountId, '2026-11-12', 2);
    await makeTokenPair(accountId);

    const result = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Журнал: строка дня записана, проект = комната, метка — расход по запросу.
    const [row] = await refs.current!
      .select()
      .from(accountsUsage)
      .where(and(eq(accountsUsage.accountId, accountId), eq(accountsUsage.usedOn, TODAY)));
    expect(row).toBeDefined();
    expect(row!.source).toBe('api');
    expect(row!.tokens).toBe(400);
    const [project] = await refs.current!
      .select()
      .from(accountsProject)
      .where(eq(accountsProject.id, row!.projectId!));
    expect(project!.name).toBe('SARAFAN');

    // Аккаунт погас (used_on = сегодня) и в счётчике свободных его больше нет.
    const [account] = await refs.current!
      .select()
      .from(accountsAccount)
      .where(eq(accountsAccount.id, accountId));
    expect(account!.usedOn).toBe(TODAY);
    expect(result.offer.free).toBe(0);
  });

  it('аккаунт, отмеченный сегодня ВЛАДЕЛЬЦЕМ, не выдаётся вовсе и его запись не трогается', async () => {
    // Аккаунт сегодня отмечен владельцем (его проект, его очки, метка owner). Правило
    // владельца: чек-ин в сутки один — очки сегодня уже сожжены, такой аккаунт
    // проекту бесполезен (просьба Сарафана, id 146), значит и не выдаётся. Запись
    // владельца при этом не переписывается: его 400 очков остаются его.
    const accountId = await makeAccount('Отмеченный владельцем', 'own@example.test', null, null);
    await makeTokenPair(accountId);
    const [ownerProject] = await refs.current!
      .insert(accountsProject)
      .values({ userId: OWNER_ID, name: 'Матрица РМЗ' })
      .returning({ id: accountsProject.id });
    await refs.current!.insert(accountsUsage).values({
      userId: OWNER_ID,
      accountId,
      projectId: ownerProject!.id,
      usedOn: TODAY,
      tokens: 1000,
      activationIndex: 4,
      source: 'owner',
    });

    const result = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Не отдан — и очков у него сегодня нет.
    expect(result.offer.account).toBeNull();

    // Запись владельца не переписана: проект, очки и метка те же.
    const [row] = await refs.current!
      .select()
      .from(accountsUsage)
      .where(and(eq(accountsUsage.accountId, accountId), eq(accountsUsage.usedOn, TODAY)));
    expect(row!.projectId).toBe(ownerProject!.id);
    expect(row!.tokens).toBe(1000);
    expect(row!.source).toBe('owner');
  });

  it('класс очков — по потребителю: Сарафану 400 первыми, панели программирования 1000', async () => {
    // Мандат владельца (14.11, 00:30 МСК): «Сарафану в приоритете предлагать 400
    // очковые токены, если нету то 1000-е предлагать, а панели программирования
    // предлагать в приоритете 1000 токены, а если нет то 400 очковые». Потребитель
    // ничего не задаёт — выбор делаем мы.
    const thousand = await makeAccount('Тысячник', 'thousand@example.test', null, null);
    await makeCheckIn(thousand, '2026-11-10', 1);
    await makeCheckIn(thousand, '2026-11-11', 2);
    await makeCheckIn(thousand, '2026-11-12', 3);
    await makeTokenPair(thousand);
    const four = await makeAccount('Четырёхсотый', 'four@example.test', null, null);
    await makeCheckIn(four, '2026-11-12', 1);
    await makeTokenPair(four);

    // Комната Сарафана (setka) — четырёхсотовые первыми.
    const sarafan = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(sarafan.ok).toBe(true);
    if (!sarafan.ok) return;
    expect(sarafan.offer.tier).toBe('points_400');

    // Панель программирования (brain) — тысячные первыми.
    await makeRoom('brain', 'brain', OTHER_ROOM_TOKEN);
    const forPanel = await issueAccount(OTHER_ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(forPanel.ok).toBe(true);
    if (!forPanel.ok) return;
    expect(forPanel.offer.tier).toBe('points_1000');
    expect(forPanel.offer.account?.points_next).toBe(1000);
  });

  it('пара наружу не отдаётся НИКОГДА: цепочка токенов наша', async () => {
    const accountId = await makeAccount('С парой', 'pair@example.test', null, null);
    await makeCheckIn(accountId, '2026-11-12', 2);
    await makeTokenPair(accountId);

    const result = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offer.access_token).toBe('ACCESS-1');
    // Refresh в ответе нет: мандат владельца — «отдавай ему только по одному токену».
    expect('refresh_token' in result.offer).toBe(false);
  });

  it('без добытой пары токенов аккаунт не отдаётся: причина «токены не готовы»', async () => {
    await makeAccount('Без токена', 'notoken@example.test', null, null);
    const result = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offer.account).toBeNull();
    expect(result.offer.reason).toBe('no_tokens_ready');
  });

  it('аккаунт с ПРОТУХШЕЙ парой в раздачу не идёт — отдать сломанный вход хуже, чем ничего', async () => {
    // Access-токен MiniMax живёт 12 часов; протухшая пара проекту бесполезна, а наш
    // refresh мы не крутим (цепочка одна). Значит такой аккаунт в выдаче — тихая
    // поломка у проекта, и мы его не отдаём.
    const accountId = await makeAccount('С протухшей парой', 'deadpair@example.test', null, null);
    await makeCheckIn(accountId, '2026-11-12', 2);
    await refs.current!.insert(accountToken).values({
      userId: OWNER_ID,
      accountId,
      ciphertext: 'x',
      iv: 'x',
      authTag: 'x',
      expiresAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    });

    const result = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offer.account).toBeNull();
    expect(result.offer.reason).toBe('no_tokens_ready');
  });
});


describe('пул MiniMax: наблюдение потребителя', () => {
  it('факт очков ложится в журнал, расхождение с предсказанием возвращается', async () => {
    // Заказ владельца 14.11: потребитель присылает, сколько очков было на токене, —
    // чтобы мы подтвердили предсказание или подкорректировали свои числа.
    const accountId = await makeAccount('Наблюдаемый', 'obs@example.test', null, null);
    await makeCheckIn(accountId, '2026-11-12', 2); // серия 1 → клетка 2 → 400 очков
    await makeTokenPair(accountId);
    const issued = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(issued.ok).toBe(true);

    const result = await recordObservation(
      ROOM_TOKEN,
      '127.0.0.1',
      { accountId, points: 1000 },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Факт — истина; предсказание и расхождение видны.
    expect(result.record.points).toBe(1000);
    expect(result.record.points_expected).toBe(400);
    expect(result.record.points_mismatch).toBe(true);
    expect(result.record.source).toBe('client_points');

    // В журнале теперь факт. Проект и метка — наши, наблюдение их не переписало.
    const [row] = await refs.current!
      .select()
      .from(accountsUsage)
      .where(and(eq(accountsUsage.accountId, accountId), eq(accountsUsage.usedOn, TODAY)));
    expect(row!.tokens).toBe(1000);
    expect(row!.source).toBe('api');
    const [project] = await refs.current!
      .select()
      .from(accountsProject)
      .where(eq(accountsProject.id, row!.projectId!));
    expect(project!.name).toBe('SARAFAN');
  });

  it('по аккаунту, который мы сегодня не выдавали, — 404', async () => {
    const accountId = await makeAccount('Невыданный', 'unissued@example.test', null, null);
    const result = await recordObservation(
      ROOM_TOKEN,
      '127.0.0.1',
      { accountId, points: 400 },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(404);
  });

  it('без account_id и email — 400', async () => {
    const result = await recordObservation(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(400);
  });
});
