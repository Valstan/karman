import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import {
  authUser,
  passportIdentity,
  passportIssuer,
  secretsAudit,
  secretsProject,
  secretsToken,
} from '@/lib/db/schema';
import {
  acceptGrantByToken,
  deleteProject,
  proposeGrantByToken,
  pullByToken,
  pushByToken,
  revokeGrantByToken,
  updateProject,
} from '@/lib/services/secrets';
import { generateToken, hashToken } from '@/lib/secrets/token';

/**
 * R1, инварианты доступа `secrets.ts` (1300 строк авторизации чужих секретов),
 * а не CRUD. Фикстуры — прямыми инсертами через тот же мокнутый db.
 * Подмена — `vi.mock('@/lib/db/client')` (см. `lib/db/test-db.ts`).
 */
const refs = vi.hoisted(() => ({ current: undefined as TestDb | undefined }));
vi.mock('@/lib/db/client', () => ({
  get db() {
    return refs.current;
  },
}));

// Фикстура мастер-ключа: crypto читает env при каждом вызове, импорт не важен.
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

let pg: PGlite | undefined;

beforeEach(async () => {
  const t = await createTestDb();
  pg = t.pg;
  refs.current = t.db;
});

afterEach(async () => {
  refs.current = undefined;
  await pg?.close();
});

type Room = { projectId: number; rwToken: string; roToken: string };

async function makeRoom(slug: string): Promise<Room> {
  const db = refs.current!;
  const [p] = await db
    .insert(secretsProject)
    .values({ userId: 1, name: slug, slug })
    .returning({ id: secretsProject.id });
  async function mint(canWrite: boolean): Promise<string> {
    const t = generateToken();
    await db.insert(secretsToken).values({
      projectId: p!.id,
      name: 'test',
      tokenPrefix: t.prefix,
      tokenHash: t.hash,
      canWrite,
    });
    return t.token;
  }
  return { projectId: p!.id, rwToken: await mint(true), roToken: await mint(false) };
}

describe('токен: неразличимость отказов', () => {
  it('битый и неизвестный токены отвечают одинаково (401, та же форма)', async () => {
    const bad = await pullByToken('nota-token', null);
    const unknown = await pullByToken(`${generateToken().token}xx`, null);
    expect(bad).toEqual({ ok: false, status: 401, error: 'Недействительный токен' });
    expect(unknown).toEqual(bad);
  });

  it('отозванный токен не читает (401)', async () => {
    const room = await makeRoom('alpha');
    const db = refs.current!;
    await db
      .update(secretsToken)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(secretsToken.tokenHash, hashToken(room.rwToken)));
    const res = await pullByToken(room.rwToken, null);
    expect(res).toEqual({ ok: false, status: 401, error: 'Недействительный токен' });
  });
});

describe('паспортные сессии: срок и отзыв личности', () => {
  async function mintSession(opts: { expired: boolean; identityRevoked: boolean }) {
    const db = refs.current!;
    const room = await makeRoom('sess');
    const [iss] = await db
      .insert(passportIssuer)
      .values({
        issuer: 'https://test-issuer',
        jwksUri: 'https://test-issuer/jwks',
        audience: 'karman-vault',
        subjectPattern: '^repo:',
        identityClaim: 'repository_id',
      })
      .returning({ id: passportIssuer.id });
    const [ident] = await db
      .insert(passportIdentity)
      .values({
        issuerId: iss!.id,
        identityValue: '123',
        label: 'Valstan/test',
        projectId: room.projectId,
        canWrite: true,
        revokedAt: opts.identityRevoked ? new Date().toISOString() : null,
      })
      .returning({ id: passportIdentity.id });
    const t = generateToken();
    await db.insert(secretsToken).values({
      projectId: room.projectId,
      name: 'session',
      tokenPrefix: t.prefix,
      tokenHash: t.hash,
      canWrite: true,
      expiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 3_600_000)).toISOString(),
      identityId: ident!.id,
    });
    return t.token;
  }

  it('истёкшая сессия не читает (401)', async () => {
    const res = await pullByToken(await mintSession({ expired: true, identityRevoked: false }), null);
    expect(res).toEqual({ ok: false, status: 401, error: 'Недействительный токен' });
  });

  it('отзыв личности гасит живую сессию на чтении (401)', async () => {
    const res = await pullByToken(await mintSession({ expired: false, identityRevoked: true }), null);
    expect(res).toEqual({ ok: false, status: 401, error: 'Недействительный токен' });
  });
});

describe('изоляция комнат', () => {
  it('pull отдаёт свои ключи plaintext и не видит чужие', async () => {
    const a = await makeRoom('room-a');
    const b = await makeRoom('room-b');
    expect(await pushByToken(a.rwToken, null, { API_KEY: 'secret-a' })).toEqual({
      ok: true,
      written: 1,
    });
    const gotA = await pullByToken(a.rwToken, null);
    expect(gotA).toEqual({ ok: true, secrets: { API_KEY: 'secret-a' } });
    const gotB = await pullByToken(b.rwToken, null);
    expect(gotB).toEqual({ ok: true, secrets: {} });
  });

  it('push read-only токеном — 403', async () => {
    const room = await makeRoom('ro-room');
    expect(await pushByToken(room.roToken, null, { K: 'v' })).toEqual({
      ok: false,
      status: 403,
      error: 'Токен не имеет прав записи',
    });
  });

  it('промах фильтра — громкий 404 со списком (G331)', async () => {
    const room = await makeRoom('q-room');
    await pushByToken(room.rwToken, null, { HAVE: '1' });
    const res = await pullByToken(room.rwToken, null, ['HAVE', 'MISSING']);
    expect(res).toEqual({
      ok: false,
      status: 404,
      error: 'Не найдено ключей: 1 из 2',
      missing: ['MISSING'],
    });
  });
});

describe('двусторонние выдачи', () => {
  async function propose(src: Room, dstSlug: string, key = 'SHARED', alias = 'SHARED') {
    return proposeGrantByToken(src.rwToken, null, {
      key,
      target_slug: dstSlug,
      alias,
      note: 'test',
    });
  }

  it('предложение не входит в выдачу до accept', async () => {
    const src = await makeRoom('src-a');
    const dst = await makeRoom('dst-a');
    await pushByToken(src.rwToken, null, { SHARED: 's3cr3t' });
    const p = await propose(src, 'dst-a');
    expect(p.ok).toBe(true);
    const res = await pullByToken(dst.rwToken, null, ['SHARED']);
    expect(res.ok).toBe(false);
    if (!res.ok && res.status === 404) expect(res.missing).toEqual(['SHARED']);
    else throw new Error(`ожидался 404-missing, получено: ${JSON.stringify(res)}`);
  });

  it('после accept выдача читается под alias именем источника', async () => {
    const src = await makeRoom('src-b');
    const dst = await makeRoom('dst-b');
    await pushByToken(src.rwToken, null, { REAL: 's3cr3t' });
    const p = await propose(src, 'dst-b', 'REAL', 'ALIAS');
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error('propose failed');
    expect(await acceptGrantByToken(dst.rwToken, null, p.id)).toEqual({ ok: true, id: p.id });
    expect(await pullByToken(dst.rwToken, null, ['ALIAS'])).toEqual({
      ok: true,
      secrets: { ALIAS: 's3cr3t' },
    });
  });

  it('чужое предложение не видно (404), повторный accept — 409', async () => {
    const src = await makeRoom('src-c');
    const dst = await makeRoom('dst-c');
    const third = await makeRoom('third-c');
    await pushByToken(src.rwToken, null, { K: 'v' });
    const p = await propose(src, 'dst-c', 'K', 'KK');
    if (!p.ok) throw new Error('propose failed');
    expect(await acceptGrantByToken(third.rwToken, null, p.id)).toEqual({
      ok: false,
      status: 404,
      error: 'Предложение не найдено',
    });
    expect(await acceptGrantByToken(dst.rwToken, null, p.id)).toEqual({ ok: true, id: p.id });
    expect(await acceptGrantByToken(dst.rwToken, null, p.id)).toEqual({
      ok: false,
      status: 409,
      error: 'Выдача уже принята',
    });
  });

  it('предлагать read-only токеном — 403', async () => {
    const src = await makeRoom('src-d');
    await makeRoom('dst-d');
    expect(await proposeGrantByToken(src.roToken, null, { key: 'K', target_slug: 'dst-d', note: 't' })).toEqual({
      ok: false,
      status: 403,
      error: 'Выдавать доступ может только токен с правом записи',
    });
  });

  it('своё имя поверх выдачи не занять (push 403) — отрезало бы от чужого значения', async () => {
    const src = await makeRoom('src-e');
    const dst = await makeRoom('dst-e');
    await pushByToken(src.rwToken, null, { K: 'v' });
    const p = await propose(src, 'dst-e', 'K', 'BORROWED');
    if (!p.ok) throw new Error('propose failed');
    expect(await acceptGrantByToken(dst.rwToken, null, p.id)).toEqual({ ok: true, id: p.id });
    const res = await pushByToken(dst.rwToken, null, { BORROWED: 'mine' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
    else throw new Error('push поверх выдачи обязан отклоняться');
  });

  it('отзыв гасит доставку: alias снова 404', async () => {
    const src = await makeRoom('src-f');
    const dst = await makeRoom('dst-f');
    await pushByToken(src.rwToken, null, { K: 'v' });
    const p = await propose(src, 'dst-f', 'K', 'GONE');
    if (!p.ok) throw new Error('propose failed');
    await acceptGrantByToken(dst.rwToken, null, p.id);
    expect(await pullByToken(dst.rwToken, null, ['GONE'])).toEqual({
      ok: true,
      secrets: { GONE: 'v' },
    });
    expect(await revokeGrantByToken(src.rwToken, null, p.id)).toEqual({ ok: true, id: p.id });
    const res = await pullByToken(dst.rwToken, null, ['GONE']);
    expect(res.ok).toBe(false);
    if (!res.ok && res.status === 404) expect(res.missing).toEqual(['GONE']);
    else throw new Error(`ожидался 404-missing, получено: ${JSON.stringify(res)}`);
  });
});

describe('владение комнатой: исключений нет даже у суперпользователя', () => {
  const admin = {
    id: 1,
    username: 'admin',
    email: '',
    firstName: '',
    lastName: '',
    isSuperuser: true,
  };

  async function makeForeignRoom() {
    const db = refs.current!;
    const [u] = await db
      .insert(authUser)
      .values({ username: 'user2', password: 'x', email: '' })
      .returning({ id: authUser.id });
    const [p] = await db
      .insert(secretsProject)
      .values({ userId: u!.id, name: 'foreign', slug: 'foreign' })
      .returning({ id: secretsProject.id });
    return p!.id;
  }

  it('update чужой комнаты — false, строка не тронута', async () => {
    const id = await makeForeignRoom();
    expect(await updateProject(admin, { id, name: 'hijack', slug: 'hijack' })).toBe(false);
    const db = refs.current!;
    const [row] = await db
      .select({ slug: secretsProject.slug })
      .from(secretsProject)
      .where(eq(secretsProject.id, id));
    expect(row?.slug).toBe('foreign');
  });

  it('delete чужой комнаты — false, комната на месте', async () => {
    const id = await makeForeignRoom();
    expect(await deleteProject(admin, id)).toBe(false);
    const db = refs.current!;
    const rows = await db.select().from(secretsProject).where(eq(secretsProject.id, id));
    expect(rows.length).toBe(1);
  });

  it('delete своей — true, факт в аудите строкой с project_id NULL', async () => {
    const room = await makeRoom('mine');
    expect(await deleteProject(admin, room.projectId)).toBe(true);
    const db = refs.current!;
    const gone = await db
      .select()
      .from(secretsProject)
      .where(eq(secretsProject.id, room.projectId));
    expect(gone.length).toBe(0);
    const [audit] = await db
      .select({ projectId: secretsAudit.projectId, action: secretsAudit.action })
      .from(secretsAudit)
      .where(eq(secretsAudit.action, 'project_deleted'));
    expect(audit).toMatchObject({ projectId: null, action: 'project_deleted' });
  });
});
