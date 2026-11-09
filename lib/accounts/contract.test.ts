import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import { accountsAccount, accountsUsage, authUser } from '@/lib/db/schema';
import {
  activateAccount,
  correctActivationIndex,
  createAccount,
  createProject,
  listAccounts,
  updateAccount,
} from '@/lib/services/accounts';
import {
  accountActivateSchema,
  accountActivationIndexSchema,
  accountCreateSchema,
  accountUpdateSchema,
} from '@/lib/validation/account';
import type { SessionUser } from '@/lib/auth/rbac';

/**
 * G54 — живой round-trip контракта «Минимакс» (тип → клиент → валидатор →
 * сервис → хранилище → обратное чтение).
 *
 * Зачем отдельным файлом, а не в `lib/services/accounts.test.ts`: тот бьёт по
 * сервисам напрямую и минует слой валидации, а именно он молча срезает новые
 * optional-поля (строгая/strip-схема). Юнит-зелёный это НЕ ловит — ловит
 * только прогон полной цепочки через настоящие схемы.
 *
 * Правило G54 срабатывает по событию «контракт расширился optional-полем»:
 * каждый раз, когда в `lib/validation/account.ts` появляется новое поле, сюда
 * добавляется проверка, что оно доезжает до БД и читается обратно.
 *
 * Изоляция: своя БД на файл, не на тест. pglite поднимает ВСЮ схему заново
 * (bootstrap.sql + цепочка рукописных миграций) — холодный бут стоит ~10–20 с,
 * и шесть таких бутов подряд роняли гейт по таймауту хука (10 с по умолчанию)
 * на загруженной машине. Тесты не мешают друг другу: у каждого свои аккаунты
 * и почты, а все утверждения привязаны к своим id (не к «первому в списке»).
 */
const refs = vi.hoisted(() => ({ current: undefined as TestDb | undefined }));
vi.mock('@/lib/db/client', () => ({
  get db() {
    return refs.current;
  },
}));

// Фикстура мастер-ключа: crypto читает env при каждом вызове.
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString('base64');

let pg: PGlite | undefined;

const owner: SessionUser = {
  id: 1,
  username: 'admin',
  email: '',
  firstName: '',
  lastName: '',
  isSuperuser: true,
};

beforeAll(async () => {
  const t = await createTestDb();
  pg = t.pg;
  refs.current = t.db;
});

afterAll(async () => {
  refs.current = undefined;
  await pg?.close();
});

const NOW = new Date('2026-11-03T12:00:00Z');

describe('G54: контракт проходит все слои целиком', () => {
  it('create: название без значения доезжает до БД дефолтом, а не пропадает', async () => {
    // Клиент присылает только почту и пароль (так делает форма импорта).
    const payload = { email: 'roundtrip@example.test', password: 'пароль' };
    const parsed = accountCreateSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const id = await createAccount(owner, parsed.data);
    const [row] = await refs.current!
      .select()
      .from(accountsAccount)
      .where(eq(accountsAccount.id, id));
    expect(row!.title).toBe('');
    expect(row!.email).toBe('roundtrip@example.test');
  });

  it('create: название, заданное явно, доезжает и читается обратно', async () => {
    const payload = {
      title: 'Матрица РМЗ — 1',
      email: 'named@example.test',
      password: 'пароль',
    };
    const parsed = accountCreateSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const id = await createAccount(owner, parsed.data);
    const list = await listAccounts(owner, NOW);
    expect(list.find((r) => r.id === id)!.title).toBe('Матрица РМЗ — 1');
  });

  it('update: незаполненные optional-поля остаются undefined (сервис их не затирает)', async () => {
    const id = await createAccount(owner, {
      title: 'Старое',
      email: 'keep@example.test',
      password: 'пароль',
    });
    // Форма правки без пароля: ключ не отправляется.
    const parsed = accountUpdateSchema.safeParse({ id, title: 'Новое' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.password).toBeUndefined();
    expect(parsed.data.email).toBeUndefined();

    expect(await updateAccount(owner, parsed.data)).toBe(true);
    const [row] = await refs.current!
      .select()
      .from(accountsAccount)
      .where(eq(accountsAccount.id, id));
    expect(row!.title).toBe('Новое');
    // Почта не затерлась: её не передавали.
    expect(row!.email).toBe('keep@example.test');
  });

  it('update: смена проекта доезжает до БД и читается обратно, undefined — «не меняю»', async () => {
    const first = await createProject(owner, { name: 'Матрица РМЗ' });
    const id = await createAccount(owner, {
      title: 'A',
      email: 'project@example.test',
      password: 'пароль',
    });

    // undefined — проект не трогаем (правка названия не должна затирать проект).
    const keep = accountUpdateSchema.safeParse({ id, title: 'Переименован' });
    expect(keep.success).toBe(true);
    if (!keep.success) return;
    expect(keep.data.projectId).toBeUndefined();
    expect(await updateAccount(owner, keep.data)).toBe(true);

    // Число — переключаем проект.
    const switchTo = accountUpdateSchema.safeParse({ id, projectId: first });
    expect(switchTo.success).toBe(true);
    if (!switchTo.success) return;
    expect(await updateAccount(owner, switchTo.data)).toBe(true);
    const list = await listAccounts(owner, NOW);
    expect(list.find((r) => r.id === id)!.projectId).toBe(first);
    expect(list.find((r) => r.id === id)!.projectName).toBe('Матрица РМЗ');

    // null — проект снимаем.
    const drop = accountUpdateSchema.safeParse({ id, projectId: null });
    expect(drop.success).toBe(true);
    if (!drop.success) return;
    expect(await updateAccount(owner, drop.data)).toBe(true);
    const after = await listAccounts(owner, NOW);
    expect(after.find((r) => r.id === id)!.projectId).toBeNull();

    // Чужой проект не принимается: аккаунт остаётся прежним.
    const [strangerUser] = await refs.current!
      .insert(authUser)
      .values({ password: 'x', username: 'stranger', email: '' })
      .returning({ id: authUser.id });
    const stranger: SessionUser = {
      ...owner,
      id: strangerUser!.id,
      isSuperuser: false,
    };
    const foreign = await createProject(stranger, { name: 'Чужой проект' });
    const bad = accountUpdateSchema.safeParse({ id, projectId: foreign });
    expect(bad.success).toBe(true);
    if (!bad.success) return;
    expect(await updateAccount(owner, bad.data)).toBe(false);
    const still = await listAccounts(owner, NOW);
    expect(still.find((r) => r.id === id)!.projectId).toBeNull();
  });

  it('activate: undefined / null / число для проекта различаются и не теряются', async () => {
    const projectId = await createProject(owner, { name: 'Сабантуй' });
    const id = await createAccount(owner, {
      title: 'A',
      email: 'activate@example.test',
      password: 'пароль',
    });

    // undefined — «проект не меняю».
    const keep = accountActivateSchema.safeParse({ id });
    expect(keep.success).toBe(true);
    if (!keep.success) return;
    expect(keep.data.projectId).toBeUndefined();

    // null — «проекта нет».
    const none = accountActivateSchema.safeParse({ id, projectId: null });
    expect(none.success).toBe(true);
    if (!none.success) return;
    expect(none.data.projectId).toBeNull();

    // Число — «проект такой».
    const some = accountActivateSchema.safeParse({ id, projectId });
    expect(some.success).toBe(true);
    if (!some.success) return;
    expect(some.data.projectId).toBe(projectId);

    await activateAccount(owner, some.data, NOW);
    const [row] = await refs.current!
      .select()
      .from(accountsAccount)
      .where(eq(accountsAccount.id, id));
    expect(row!.usedProjectId).toBe(projectId);
  });

  it('activate: токены undefined — «не меняю», а ноль', async () => {
    const id = await createAccount(owner, {
      title: 'A',
      email: 'tokens@example.test',
      password: 'пароль',
    });
    const first = accountActivateSchema.safeParse({ id, tokens: 500 });
    expect(first.success).toBe(true);
    if (!first.success) return;
    await activateAccount(owner, first.data, NOW);

    const second = accountActivateSchema.safeParse({ id });
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data.tokens).toBeUndefined();
    await activateAccount(owner, second.data, NOW);

    const rows = await refs.current!
      .select()
      .from(accountsUsage)
      .where(eq(accountsUsage.accountId, id));
    expect(rows.length).toBe(1);
    expect(rows[0]!.tokens).toBe(500);
  });

  it('activate: окно активации — 10 часов от момента, и обратное чтение это видно', async () => {
    const id = await createAccount(owner, {
      title: 'A',
      email: 'window@example.test',
      password: 'пароль',
    });
    const parsed = accountActivateSchema.safeParse({ id, tokens: 10 });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    await activateAccount(owner, parsed.data, NOW);

    // Через час окно ещё открыто — аккаунт израсходован.
    const soon = await listAccounts(owner, new Date(NOW.getTime() + 60 * 60 * 1000));
    const justNow = soon.find((r) => r.id === id)!;
    expect(justNow.spent).toBe(true);
    expect(justNow.availableAt).toBe('2026-11-03T22:00:00.000Z');

    // Через 11 часов — снова свободен (окно простоя 10 часов, заказ 08.11).
    const later = await listAccounts(owner, new Date(NOW.getTime() + 11 * 60 * 60 * 1000));
    expect(later.find((r) => r.id === id)!.spent).toBe(false);
  });

  it('activate: номер активации доезжает до БД и читается обратно (G54)', async () => {
    const id = await createAccount(owner, {
      title: 'A',
      email: 'index@example.test',
      password: 'пароль',
    });

    // Номер не задан — программа определяет его сама (первая активация).
    const auto = accountActivateSchema.safeParse({ id });
    expect(auto.success).toBe(true);
    if (!auto.success) return;
    expect(auto.data.activationIndex).toBeUndefined();
    await activateAccount(owner, auto.data, NOW);

    const [row] = await refs.current!
      .select()
      .from(accountsUsage)
      .where(eq(accountsUsage.accountId, id));
    // Первая активация недели → 1, очки по ней — 400.
    expect(row!.activationIndex).toBe(1);
    expect(row!.tokens).toBe(400);

    // Номер задан владельцем — доезжает и он, и очки по нему (4-я → 1000).
    const second = accountActivateSchema.safeParse({
      id,
      activationIndex: 4,
      tokens: undefined,
    });
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data.activationIndex).toBe(4);
    await activateAccount(owner, second.data, new Date(NOW.getTime() + 24 * 60 * 60 * 1000));

    const rows = await refs.current!
      .select()
      .from(accountsUsage)
      .where(eq(accountsUsage.accountId, id));
    expect(rows.length).toBe(2);
    const secondRow = rows.find((r) => r.usedOn === '2026-11-04')!;
    expect(secondRow.activationIndex).toBe(4);
    expect(secondRow.tokens).toBe(1000);

    // Обратное чтение: недельная квота аккаунта знает про подтверждённый номер.
    const list = await listAccounts(owner, new Date(NOW.getTime() + 24 * 60 * 60 * 1000));
    const account = list.find((r) => r.id === id)!;
    expect(account.week.used).toBe(2);
    expect(account.week.confirmedIndex).toBe(4);
    // Номер клетки считается по датам (серия дней подряд, разбор 09.11): 03.11
    // и 04.11 — два дня подряд, значит следующая клетка третья.
    expect(account.week.nextIndex).toBe(3);
  });

  it('activate: номер вне 1..7 не принимается валидатором', async () => {
    const bad = accountActivateSchema.safeParse({ id: 1, activationIndex: 8 });
    expect(bad.success).toBe(false);
    const zero = accountActivateSchema.safeParse({ id: 1, activationIndex: 0 });
    expect(zero.success).toBe(false);
  });

  it('правка номера активации: номер и очки пересчитываются в БД (заказ 08.11)', async () => {
    // Владелец активировал аккаунт, потом посмотрел настоящую панель MiniMax и
    // назвал другой номер клетки («забыл, неправильно поставил»).
    const id = await createAccount(owner, {
      title: 'A',
      email: 'correct@example.test',
      password: 'пароль',
    });
    const first = accountActivateSchema.safeParse({ id, activationIndex: 1 });
    expect(first.success).toBe(true);
    if (!first.success) return;
    await activateAccount(owner, first.data, NOW);

    const fixed = accountActivationIndexSchema.safeParse({ id, activationIndex: 4 });
    expect(fixed.success).toBe(true);
    if (!fixed.success) return;
    expect(fixed.data.activationIndex).toBe(4);
    expect(await correctActivationIndex(owner, id, fixed.data.activationIndex)).toBe(true);

    // Номер и очки в журнале пересчитаны: 4-я клетка — 1000 очков.
    const rows = await refs.current!
      .select()
      .from(accountsUsage)
      .where(eq(accountsUsage.accountId, id));
    expect(rows.length).toBe(1);
    expect(rows[0]!.activationIndex).toBe(4);
    expect(rows[0]!.tokens).toBe(1000);

    // Очки в строке аккаунта — те же, что в журнале.
    const [account] = await refs.current!
      .select()
      .from(accountsAccount)
      .where(eq(accountsAccount.id, id));
    expect(account!.lastTokens).toBe(1000);

    // Обратное чтение: недельная квота знает номер, названный владельцем, а
    // подсказку считает сама — по серии дней подряд (разбор 09.11): отмечен
    // сегодня один день, значит следующая клетка вторая.
    const list = await listAccounts(owner, NOW);
    const row = list.find((r) => r.id === id)!;
    expect(row.week.confirmedIndex).toBe(4);
    expect(row.week.nextIndex).toBe(2);
  });

  it('правка номера активации: номер вне 1..7 не принимается валидатором', async () => {
    const bad = accountActivationIndexSchema.safeParse({ id: 1, activationIndex: 8 });
    expect(bad.success).toBe(false);
    const zero = accountActivationIndexSchema.safeParse({ id: 1, activationIndex: 0 });
    expect(zero.success).toBe(false);
  });
});
