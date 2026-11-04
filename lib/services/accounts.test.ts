import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import { accountsAccount, accountsUsage, authUser } from '@/lib/db/schema';
import {
  accountPassword,
  activateAccount,
  createAccount,
  createProject,
  deleteAccount,
  importAccounts,
  listAccounts,
  listProjects,
  projectUsage,
} from '@/lib/services/accounts';
import type { SessionUser } from '@/lib/auth/rbac';

/**
 * Мультиаккаунт: инварианты, ради которых раздел и делался.
 *
 * 1. Копирование = активация: аккаунт гаснет на СВОИ 24 часа от момента
 *    активации (не до полуночи по календарю).
 * 2. Одна активация на окно: копирование почты и копирование пароля — одна и
 *    та же активация (иначе статистика по проектам удваивалась бы).
 * 3. Токены не затираются вторым копированием.
 * 4. Пароль в БД — только шифротекст; AAD привязывает его к строке.
 * 5. Чужой аккаунт/проект — не виден и не активируется.
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

const stranger: SessionUser = {
  id: 2,
  username: 'guest',
  email: '',
  firstName: '',
  lastName: '',
  isSuperuser: false,
};

beforeEach(async () => {
  const t = await createTestDb();
  pg = t.pg;
  refs.current = t.db;
  // Владелец (admin, id=1) уже засеян bootstrap'ом; добавляем второго
  // пользователя — «чужого», чтобы проверять изоляцию по user_id.
  await refs.current!
    .insert(authUser)
    .values({ id: 2, password: 'x', username: 'guest' } as never);
});

afterEach(async () => {
  refs.current = undefined;
  await pg?.close();
});

const NOW = new Date('2026-11-03T12:00:00Z');
/** Момент за 30 часов до NOW — аккаунт активирован, но его окно 24 ч истекло. */
const LONG_AGO = new Date('2026-11-02T06:00:00Z');
/** Момент за 12 часов до NOW — окно ещё открыто. */
const RECENTLY = new Date('2026-11-03T00:00:00Z');

describe('мультиаккаунт: создание и пароль', () => {
  it('пароль в БД — только шифротекст, и он расшифровывается обратно', async () => {
    const id = await createAccount(owner, { title: 'Матрица', email: 'a@example.test', password: 'пароль-1' });
    const [row] = await refs.current!
      .select()
      .from(accountsAccount)
      .where(eq(accountsAccount.id, id));
    expect(row!.passwordCt).not.toContain('пароль-1');
    expect(row!.email).toBe('a@example.test');
    expect(await accountPassword(owner, id)).toBe('пароль-1');
  });

  it('чужой пользователь не читает пароль', async () => {
    const id = await createAccount(owner, { title: '', email: 'b@example.test', password: 'пароль-2' });
    expect(await accountPassword(stranger, id)).toBeNull();
  });

  it('удаление аккаунта убирает его из списка', async () => {
    const id = await createAccount(owner, { title: '', email: 'c@example.test', password: 'p' });
    expect(await deleteAccount(owner, id)).toBe(true);
    expect(await deleteAccount(owner, id)).toBe(false);
    expect((await listAccounts(owner)).length).toBe(0);
  });
});

describe('мультиаккаунт: активация и тушение на 24 часа', () => {
  it('активация гасит аккаунт: он уходит вниз списка', async () => {
    const a = await createAccount(owner, { title: 'A', email: 'a@example.test', password: 'p' });
    const b = await createAccount(owner, { title: 'B', email: 'b@example.test', password: 'p' });
    await activateAccount(owner, { id: a, projectId: null, tokens: 100 }, NOW);

    const list = await listAccounts(owner, NOW);
    expect(list.map((row) => row.id)).toEqual([b, a]);
    expect(list[1]!.spent).toBe(true);
    expect(list[0]!.spent).toBe(false);
  });

  it('окно своё у каждого: активированный 30 часов назад снова свободен', async () => {
    const a = await createAccount(owner, { title: 'A', email: 'a@example.test', password: 'p' });
    await activateAccount(owner, { id: a, projectId: null, tokens: 0 }, LONG_AGO);
    const list = await listAccounts(owner, NOW);
    expect(list[0]!.spent).toBe(false);
  });

  it('активированный 12 часов назад ещё израсходован (вчерашняя дата не значит «свободен»)', async () => {
    const a = await createAccount(owner, { title: 'A', email: 'a@example.test', password: 'p' });
    await activateAccount(owner, { id: a, projectId: null, tokens: 0 }, RECENTLY);
    const list = await listAccounts(owner, NOW);
    expect(list[0]!.spent).toBe(true);
  });

  it('копирование почты и копирование пароля — одна активация, а не две', async () => {
    const a = await createAccount(owner, { title: 'A', email: 'a@example.test', password: 'p' });
    await activateAccount(owner, { id: a, projectId: null, tokens: 500 }, NOW);
    await activateAccount(owner, { id: a, projectId: null, tokens: undefined }, NOW);

    const rows = await refs.current!.select().from(accountsUsage);
    expect(rows.length).toBe(1);
    // Токены не затираются вторым копированием.
    expect(rows[0]!.tokens).toBe(500);
  });

  it('активация с проеклем записывает проект в строку и в журнал', async () => {
    const projectId = await createProject(owner, { name: 'Сабантуй' });
    const a = await createAccount(owner, { title: 'A', email: 'a@example.test', password: 'p' });
    await activateAccount(owner, { id: a, projectId, tokens: 42 }, NOW);

    const [row] = await refs.current!
      .select()
      .from(accountsAccount)
      .where(eq(accountsAccount.id, a));
    expect(row!.usedProjectId).toBe(projectId);
    expect(row!.lastTokens).toBe(42);
    expect(row!.usedOn).toBe('2026-11-03');
  });

  it('продолжение сессии не сдвигает окно: used_at остаётся моментом активации', async () => {
    const a = await createAccount(owner, { title: 'A', email: 'a@example.test', password: 'p' });
    await activateAccount(owner, { id: a, projectId: null, tokens: 10 }, NOW);
    const [first] = await refs.current!
      .select()
      .from(accountsAccount)
      .where(eq(accountsAccount.id, a));
    // Postgres отдаёт timestamptz строкой, поэтому сверяем момент, а не текст.
    expect(new Date(first!.usedAt!).getTime()).toBe(NOW.getTime());

    // Копирование пароля через час — та же сессия.
    await activateAccount(
      owner,
      { id: a, projectId: null, tokens: undefined },
      new Date(NOW.getTime() + 60 * 60 * 1000),
    );
    const [second] = await refs.current!
      .select()
      .from(accountsAccount)
      .where(eq(accountsAccount.id, a));
    expect(new Date(second!.usedAt!).getTime()).toBe(NOW.getTime());
    // И в журнале по-прежнему одна строка.
    const rows = await refs.current!.select().from(accountsUsage);
    expect(rows.length).toBe(1);
  });

  it('после истечения окна новая активация открывает новую сессию и новую строку журнала', async () => {
    const a = await createAccount(owner, { title: 'A', email: 'a@example.test', password: 'p' });
    await activateAccount(owner, { id: a, projectId: null, tokens: 10 }, LONG_AGO);
    // Окно 24 ч от LONG_AGO истекло к NOW — это НОВАЯ сессия.
    await activateAccount(owner, { id: a, projectId: null, tokens: 20 }, NOW);

    const rows = await refs.current!.select().from(accountsUsage);
    expect(rows.length).toBe(2);
    const [row] = await refs.current!
      .select()
      .from(accountsAccount)
      .where(eq(accountsAccount.id, a));
    expect(new Date(row!.usedAt!).getTime()).toBe(NOW.getTime());
    expect(row!.lastTokens).toBe(20);
  });

  it('чужой проект не принимается: активация не проходит', async () => {
    const a = await createAccount(owner, { title: 'A', email: 'a@example.test', password: 'p' });
    const foreignProject = await createProject(stranger, { name: 'Чужой' });
    expect(await activateAccount(owner, { id: a, projectId: foreignProject, tokens: 1 }, NOW)).toBe(
      false,
    );
  });

  it('чужой аккаунт не активируется', async () => {
    const a = await createAccount(owner, { title: 'A', email: 'a@example.test', password: 'p' });
    expect(await activateAccount(stranger, { id: a, projectId: null, tokens: 1 }, NOW)).toBe(false);
  });
});

describe('мультиаккаунт: массовый импорт', () => {
  it('импортирует список, название по умолчанию — имя ящика', async () => {
    const result = await importAccounts(owner, [
      { email: 'valstan@valstan.ru', password: 'p1' },
      { email: '1@id45d.myjino.ru', password: 'p2', title: 'Матрица РМЗ' },
    ]);
    expect(result.created).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);

    const list = await listAccounts(owner);
    const titles = list.map((row) => row.title).sort();
    // Название по умолчанию — имя ящика: «valstan@valstan.ru» → «valstan».
    // Порядок после sort(): латиница раньше кириллицы.
    expect(titles).toEqual(['valstan', 'Матрица РМЗ']);
  });

  it('повторный импорт того же списка ничего не ломает (идемпотентно)', async () => {
    const items = [{ email: 'a@example.test', password: 'p' }];
    expect((await importAccounts(owner, items)).created).toBe(1);
    const second = await importAccounts(owner, items);
    expect(second.created).toBe(0);
    expect(second.skipped).toEqual(['a@example.test']);
    expect((await listAccounts(owner)).length).toBe(1);
  });

  it('почта нормализуется в нижний регистр', async () => {
    await importAccounts(owner, [{ email: 'Mixed@Example.TEST', password: 'p' }]);
    const list = await listAccounts(owner);
    expect(list[0]!.email).toBe('mixed@example.test');
  });

  it('чужой список не импортируется', async () => {
    const result = await importAccounts(stranger, [{ email: 'x@example.test', password: 'p' }]);
    expect(result.created).toBe(1);
    expect((await listAccounts(owner)).length).toBe(0);
    expect((await listAccounts(stranger)).length).toBe(1);
  });
});

describe('мультиаккаунт: проекты и статистика', () => {  it('проекты видны только владельцу', async () => {
    await createProject(owner, { name: 'Казанская' });
    expect((await listProjects(owner)).map((p) => p.name)).toEqual(['Казанская']);
    expect((await listProjects(stranger)).length).toBe(0);
  });

  it('статистика копит токены по проектам', async () => {
    const p1 = await createProject(owner, { name: 'Матрица РМЗ' });
    const p2 = await createProject(owner, { name: 'Сабантуй' });
    const a = await createAccount(owner, { title: 'A', email: 'a@example.test', password: 'p' });
    const b = await createAccount(owner, { title: 'B', email: 'b@example.test', password: 'p' });
    // Первая сессия аккаунта A — за 30 часов до NOW, вторая — сейчас: между ними
    // окно 24 ч успело истекнуть, значит это две РАЗНЫЕ активации в статистике.
    await activateAccount(owner, { id: a, projectId: p1, tokens: 100 }, LONG_AGO);
    await activateAccount(owner, { id: b, projectId: p2, tokens: 700 }, NOW);
    await activateAccount(owner, { id: a, projectId: p1, tokens: 250 }, NOW);

    const usage = await projectUsage(owner);
    expect(usage[0]).toEqual({
      projectId: p2,
      projectName: 'Сабантуй',
      activations: 1,
      tokens: 700,
    });
    expect(usage[1]).toEqual({
      projectId: p1,
      projectName: 'Матрица РМЗ',
      activations: 2,
      tokens: 350,
    });
  });
});
