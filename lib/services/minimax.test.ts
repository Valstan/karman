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

// Refresh одноразовый, но цепочку продлевает: при протухшем access мы обновляем
// пару сами (мандат владельца 15.11 — «токены не протухли»).
const oauth = vi.hoisted(() => ({ refreshAccessToken: vi.fn(), signinStatus: vi.fn() }));
vi.mock('@/lib/minimax/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/minimax/oauth')>();
  return { ...actual, refreshAccessToken: oauth.refreshAccessToken, signinStatus: oauth.signinStatus };
});

// Вендор: забор бонуса (заказ владельца 20.11 — забор В МОМЕНТ ВЫДАЧИ).
// Ответ на забор — единственный честный признак «есть ли на аккаунте очки».
const claim = vi.hoisted(() => ({ claimDailyBonus: vi.fn() }));
vi.mock('@/lib/minimax/claim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/minimax/claim')>();
  return { ...actual, claimDailyBonus: claim.claimDailyBonus };
});

let pg: PGlite | undefined;

const OWNER_ID = 1; // admin из scripts/bootstrap.sql
const ROOM_TOKEN = 'skm_test_room_token_0123456789abcdef';
const OTHER_ROOM_TOKEN = 'skm_test_other_room_token_0123456789';
const BRAIN_TOKEN = 'skm_test_brain_room_token_0123456789abc';
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
  // source='api' — отметка о выдаче потребителю. Ручная активация владельца
  // ('owner') убирает аккаунт из счётчика до следующего забора (заказ владельца
  // 19.11, ночь) — в обычных кейсах пула её быть не должно.
  await refs.current!.insert(accountsUsage).values({
    userId: OWNER_ID,
    accountId,
    usedOn,
    tokens: 400,
    activationIndex,
    source: 'api',
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
    // Вендорский `expires_in` — 12 часов (43 200 с), как в проде. Фикстура в час
    // была неправдоподобной и, после правила «короткий access не отдаём»
    // (остаток < 2 ч — брак), ломала тесты на живую выдачу.
    expiresAt: new Date(NOW.getTime() + 43_200_000).toISOString(),
  });
}

/**
 * Ответ вендора на забор бонуса (заказ владельца 20.11: забор в момент выдачи).
 *
 * `claim_result` 1 — клетку забрали мы (очки наши и свежие), 2 — клетку забрали
 * до нас (очки у потребителя и потрачены).
 */
function claimAnswer(
  over: { claim_result?: number; day_no?: number; points?: number; claim_id?: string } = {},
) {
  const dayNo = over.day_no ?? 2;
  const points = over.points ?? 400;
  return {
    ok: true as const,
    data: {
      claim_result: over.claim_result ?? 1,
      claim_id: over.claim_id ?? 'claim-1',
      day_no: dayNo,
      points,
      expire_at_ms: NOW.getTime() + 30 * 24 * 3_600_000,
      panel: { days: [{ day_no: dayNo, status: 3, points, is_today: true }] },
    },
  };
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
  oauth.refreshAccessToken.mockReset();
  oauth.refreshAccessToken.mockResolvedValue({
    ok: true,
    data: { accessToken: 'ACCESS-2', refreshToken: 'REFRESH-2', expiresInSeconds: 3600 },
  });
  oauth.signinStatus.mockReset();
  oauth.signinStatus.mockResolvedValue({
    ok: true,
    data: {
      days: [{ day_no: 2, status: 2, points: 400, is_today: true }],
      today: { day_no: 2, status: 2, points: 400, is_today: true },
      canClaim: true,
      points: 400,
    },
  });
  // Забор в момент выдачи: по умолчанию клетка 2 — 400 очков, забрали мы.
  claim.claimDailyBonus.mockReset();
  claim.claimDailyBonus.mockResolvedValue({
    ok: true,
    data: {
      claim_result: 1,
      claim_id: 'claim-1',
      day_no: 2,
      points: 400,
      expire_at_ms: NOW.getTime() + 30 * 24 * 3_600_000,
      panel: { days: [{ day_no: 2, status: 3, points: 400, is_today: true }] },
    },
  });
});

afterEach(async () => {
  refs.current = undefined;
  await pg?.close();
  pg = undefined;
});

describe('пул MiniMax: раздача аккаунта проекту', () => {
  it('одна карусель: разделения на 400 и 1000 больше нет', async () => {
    // Заказ владельца 20.11: «сделай одну карусель без разделения… выдавай всем
    // проектам и прод и программированию просто то что есть». Раньше тысячные
    // уходили только программированию, а продсерверу шла отдельная карусель.
    const thousand = await makeAccount('Тысячник', 'thousand@example.test', null, null);
    const four = await makeAccount('Обычный', 'four@example.test', null, null);
    // Клетка 4 → 1000 очков: три отметки подряд (10, 11, 12 → сегодня 4-я).
    await makeCheckIn(thousand, '2026-11-10', 1);
    await makeCheckIn(thousand, '2026-11-11', 2);
    await makeCheckIn(thousand, '2026-11-12', 3);
    await makeCheckIn(four, '2026-11-12', 2);
    await makeTokenPair(thousand, 'ACCESS-T');
    await makeTokenPair(four, 'ACCESS-F');
    // Забор вендора в момент выдачи: у тысячника клетка 4 — 1000 очков.
    claim.claimDailyBonus.mockImplementation(async (access: string) =>
      access === 'ACCESS-T' ? claimAnswer({ day_no: 4, points: 1000 }) : claimAnswer(),
    );

    const result = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Никто не делит пул по классам: первый в очереди — и есть.
    expect(result.offer.account?.id).toBe(thousand);
    expect(result.offer.tier).toBe('points_1000');
    expect(result.offer.account?.points_next).toBe(1000);
    expect(result.offer.account?.email).toBe('thousand@example.test');
    // Пароля в ответе нет: Сарафан работает по почте, секрет наружу не выносим.
    expect('password' in (result.offer.account ?? {})).toBe(false);
  });

  it('комната-потребителя не влияет на выдачу: тот же пул у продсервера и у панели', async () => {
    await makeRoom('gonba', 'GONBA', OTHER_ROOM_TOKEN);
    const thousand = await makeAccount('Тысячник2', 'thousand2@example.test', null, null);
    await makeCheckIn(thousand, '2026-11-10', 1);
    await makeCheckIn(thousand, '2026-11-11', 2);
    await makeCheckIn(thousand, '2026-11-12', 3);
    await makeTokenPair(thousand);
    // Забор вендора: сегодня клетка 4 — 1000 очков.
    claim.claimDailyBonus.mockResolvedValue(claimAnswer({ day_no: 4, points: 1000 }));

    const result = await issueAccount(OTHER_ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Раньше тысячная карусель была только для программирования. Теперь — одна
    // очередь на всех.
    expect(result.offer.account?.id).toBe(thousand);
    expect(result.offer.tier).toBe('points_1000');
  });

  /**
   * Очки и класс в ответе — ИЗ ЗАБОРА, а не из модели по датам.
   *
   * Модель клетки с вендором разошлась: живая сверка 16.11 — класс очков
   * (400 или 1000) расходится у 48 аккаунтов из 109. Значит обещание «1000
   * очков» от модели может оказаться пустым. Теперь ответ даёт забор, который мы
   * делаем в момент выдачи: клетка и номинал — из ответа вендора.
   */
  it('очки и класс в ответе — из забора, даже когда модель обещает тысячи', async () => {
    // Модель по датам: три отметки подряд → сегодня клетка 4 → 1000 очков.
    const accountId = await makeAccount('Модель врёт', 'lie@example.test', null, null);
    await makeCheckIn(accountId, '2026-11-10', 1);
    await makeCheckIn(accountId, '2026-11-11', 2);
    await makeCheckIn(accountId, '2026-11-12', 3);
    await makeTokenPair(accountId);
    // Забор вендора: клетка 2 — 400 очков (модель обещала тысячи).
    claim.claimDailyBonus.mockResolvedValue(claimAnswer({ day_no: 2, points: 400 }));

    const result = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Забор ответил: сегодня клетка 2, 400 очков.
    expect(result.offer.account?.id).toBe(accountId);
    expect(result.offer.account?.points_next).toBe(400);
    expect(result.offer.tier).toBe('points_400');
    expect(result.offer.account?.activation_index).toBe(2);
  });

  /**
   * Клетку забрал НЕ мы — очки у потребителя и потрачены: такой аккаунт в конец
   * очереди, а потребителю отдаём следующего (заказ владельца 20.11).
   */
  it('клетку забрали не мы — аккаунт уходит в конец очереди, отдаём следующего', async () => {
    const dead = await makeAccount('Чужая клетка', 'dead@example.test', null, null);
    const live = await makeAccount('Живая клетка', 'live@example.test', null, null);
    await makeTokenPair(dead, 'ACCESS-DEAD');
    await makeTokenPair(live, 'ACCESS-LIVE');
    // У первого клетку забрал потребитель (claim_result = 2), у второго забрали мы.
    claim.claimDailyBonus.mockImplementation(async (access: string) =>
      access === 'ACCESS-DEAD'
        ? claimAnswer({ claim_result: 2, day_no: 2, points: 400, claim_id: 'claim-theirs' })
        : claimAnswer({ day_no: 5, points: 1000, claim_id: 'claim-ours' }),
    );

    const result = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offer.account?.id).toBe(live);
    expect(result.offer.account?.points_next).toBe(1000);
  });

  /**
   * Мозг (комната brain) берёт из ТОЙ ЖЕ карусели, что и все остальные.
   *
   * Мандат владельца 14.11 («панели программирования предлагать в приоритете 1000
   * токоны») отменён заказом 20.11: одна карусель без разделения. Класс аккаунта
   * в ответе — факт забора, а не признак, по которому мы что-то отбираем.
   */
  it('Мозг берёт из общей карусели: приоритета по классу нет', async () => {
    await makeRoom('brain', 'brain', BRAIN_TOKEN);
    const thousand = await makeAccount('Тысячник', 'thousand@example.test', null, null);
    const four = await makeAccount('Четырёхсот', 'four@example.test', null, null);
    await makeTokenPair(thousand, 'ACCESS-T');
    await makeTokenPair(four, 'ACCESS-F');
    // Забор вендора: у тысячника сегодня клетка 4 (1000 очков), у второго клетка 2 (400).
    claim.claimDailyBonus.mockImplementation(async (access: string) =>
      access === 'ACCESS-T' ? claimAnswer({ day_no: 4, points: 1000 }) : claimAnswer(),
    );

    const result = await issueAccount(BRAIN_TOKEN, '127.0.0.1', {}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offer.account?.id).toBe(thousand);
    expect(result.offer.tier).toBe('points_1000');
    expect(result.offer.account?.points_next).toBe(1000);
    expect(result.offer.account?.activation_index).toBe(4);
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

  /**
   * Статистика — по проекту, ДЛЯ КОГО потребитель взял аккаунт (заказ владельца
   * 18.11: «от комнаты brain приходит информация, какому проекту запрашивается
   * аккаунт? Если присылает — и аккаунт тому проекту в статистику клади»).
   *
   * Заголовок `X-MiniMax-Project` присылает brain (17.11: 79 выдач в «MatricaRMZ»),
   * а в журнале всё лежало под комнатой-владельцем («brain») — по проектам не было
   * видно, куда ушло. Теперь журнальный проект — запрошенный.
   */
  it('аккаунт уходит в статистику запрошенного проекта, а не комнаты', async () => {
    const accountId = await makeAccount('Под проект', 'proj@example.test', null, null);
    await makeCheckIn(accountId, '2026-11-12', 2);
    await makeTokenPair(accountId);

    const result = await issueAccount(ROOM_TOKEN, '127.0.0.1', { project: 'MatricaRMZ' }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await refs.current!
      .select({ projectId: accountsUsage.projectId })
      .from(accountsUsage)
      .where(and(eq(accountsUsage.accountId, accountId), eq(accountsUsage.usedOn, TODAY)));
    expect(rows.length).toBe(1);
    const [project] = await refs.current!
      .select({ name: accountsProject.name })
      .from(accountsProject)
      .where(eq(accountsProject.id, rows[0]!.projectId!));
    expect(project?.name).toBe('MatricaRMZ');
  });

  it('без заголовка журнал остаётся за комнатой-владельцем', async () => {
    const accountId = await makeAccount('Без проекта', 'noproj@example.test', null, null);
    await makeCheckIn(accountId, '2026-11-12', 2);
    await makeTokenPair(accountId);

    const result = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await refs.current!
      .select({ projectId: accountsUsage.projectId })
      .from(accountsUsage)
      .where(and(eq(accountsUsage.accountId, accountId), eq(accountsUsage.usedOn, TODAY)));
    expect(rows.length).toBe(1);
    const [project] = await refs.current!
      .select({ name: accountsProject.name })
      .from(accountsProject)
      .where(eq(accountsProject.id, rows[0]!.projectId!));
    expect(project?.name).toBe('SARAFAN');
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
      // Активация была сегодня (в текущих сутках) — аккаунт убран из счётчика до
      // следующего забора (заказ владельца 19.11, ночь).
      createdAt: NOW.toISOString(),
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

  it('класс очков — факт забора, а не предпочтение потребителя', async () => {
    // Заказ владельца 20.11: класс больше не выбирается по потребителю (ни
    // «Сарафану 400 первыми», ни «программированию 1000»). Один пул, одна очередь,
    // а класс в ответе — то, что вендор сказал на забор.
    const thousand = await makeAccount('Тысячник', 'thousand@example.test', null, null);
    await makeCheckIn(thousand, '2026-11-10', 1);
    await makeCheckIn(thousand, '2026-11-11', 2);
    await makeCheckIn(thousand, '2026-11-12', 3);
    await makeTokenPair(thousand, 'ACCESS-T');
    const four = await makeAccount('Четырёхсотый', 'four@example.test', null, null);
    await makeCheckIn(four, '2026-11-12', 1);
    await makeTokenPair(four, 'ACCESS-F');
    // Забор вендора: у тысячника 1000, у четырёхсотого 400.
    claim.claimDailyBonus.mockImplementation(async (access: string) =>
      access === 'ACCESS-T' ? claimAnswer({ day_no: 4, points: 1000 }) : claimAnswer(),
    );

    // Комната Сарафана (setka) — первый по кругу.
    const sarafan = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(sarafan.ok).toBe(true);
    if (!sarafan.ok) return;
    expect(sarafan.offer.account?.id).toBe(thousand);
    expect(sarafan.offer.tier).toBe('points_1000');

    // Панель программирования (brain) — тот же пул, следующий по кругу.
    await makeRoom('brain', 'brain', OTHER_ROOM_TOKEN);
    const forPanel = await issueAccount(OTHER_ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(forPanel.ok).toBe(true);
    if (!forPanel.ok) return;
    expect(forPanel.offer.account?.id).toBe(four);
    expect(forPanel.offer.tier).toBe('points_400');
    expect(forPanel.offer.account?.points_next).toBe(400);
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

  it('аккаунт с ПРОТУХШИМ access в раздачу идёт: access оживляется по refresh', async () => {
    // Мандат владельца 15.11: «токены не протухли, протухло их использование на эти
    // сутки». Access живёт 12 часов, но refresh одноразовый — и вместе с новым
    // access вендор отдаёт новый refresh, то есть цепочка продлевается.
    const accountId = await makeAccount('С протухшим access', 'deadpair@example.test', null, null);
    await makeCheckIn(accountId, '2026-11-12', 2);
    await makeTokenPair(accountId, 'ACCESS-OLD', 'REFRESH-1');
    await refs.current!
      .update(accountToken)
      .set({ expiresAt: new Date(NOW.getTime() - 3_600_000).toISOString() });

    const result = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offer.account?.id).toBe(accountId);
    // Потребитель получает ЖИВОЙ access — обновлённый, а не протухший.
    expect(result.offer.access_token).toBe('ACCESS-2');
    // Refresh наружу не уходит: цепочка наша (мандат владельца 15.11).
    expect('refresh_token' in result.offer).toBe(false);
  });

  it('оборванная цепочка — аккаунт в раздачу не идёт: честная пустота, а не сломанный вход', async () => {
    const accountId = await makeAccount('С оборванной цепочкой', 'broken@example.test', null, null);
    await makeCheckIn(accountId, '2026-11-12', 2);
    await makeTokenPair(accountId, 'ACCESS-OLD', 'REFRESH-1');
    await refs.current!
      .update(accountToken)
      .set({ expiresAt: new Date(NOW.getTime() - 3_600_000).toISOString() });
    oauth.refreshAccessToken.mockResolvedValue({ ok: false, error: 'invalid_grant' });

    const result = await issueAccount(ROOM_TOKEN, '127.0.0.1', {}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offer.account).toBeNull();
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
