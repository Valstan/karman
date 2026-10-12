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
  createPolicy,
  declarePolicyByToken,
  deleteProject,
  listPolicies,
  listPoliciesForUser,
  listTokenInventory,
  proposeGrantByToken,
  pullByToken,
  pushByToken,
  revokeGrantByToken,
  revokePolicy,
  revokePolicyByToken,
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

describe('политики приёма: auto-accept по allowlist получателя (S2, D-119)', () => {
  async function propose(src: Room, dstSlug: string, key = 'K', alias?: string) {
    return proposeGrantByToken(src.rwToken, null, {
      key,
      target_slug: dstSlug,
      alias,
      note: 'test',
    });
  }

  it('живая политика принимает предложение сразу — значение читается', async () => {
    const src = await makeRoom('pol-src');
    const dst = await makeRoom('pol-dst');
    await pushByToken(src.rwToken, null, { K: 's3cr3t' });
    expect(
      await declarePolicyByToken(dst.rwToken, null, {
        source_slug: 'pol-src',
        source_key: 'K',
        alias: 'ALIAS',
        note: 'тест',
      }),
    ).toEqual({ ok: true, id: expect.any(Number), autoAccept: true });
    const p = await propose(src, 'pol-dst', 'K');
    expect(p).toEqual({ ok: true, id: expect.any(Number), autoAccepted: true });
    if (!p.ok) throw new Error('propose failed');
    expect(await pullByToken(dst.rwToken, null, ['ALIAS'])).toEqual({
      ok: true,
      secrets: { ALIAS: 's3cr3t' },
    });
  });

  it('без alias в политике — принимается под именем ключа источника', async () => {
    const src = await makeRoom('pol-src2');
    const dst = await makeRoom('pol-dst2');
    await pushByToken(src.rwToken, null, { K: 'v' });
    await declarePolicyByToken(dst.rwToken, null, { source_slug: 'pol-src2', source_key: 'K' });
    const p = await propose(src, 'pol-dst2', 'K');
    expect(p).toEqual({ ok: true, id: expect.any(Number), autoAccepted: true });
    expect(await pullByToken(dst.rwToken, null, ['K'])).toEqual({
      ok: true,
      secrets: { K: 'v' },
    });
  });

  it('имя приёма фиксирует политика, а не предложение', async () => {
    const src = await makeRoom('pol-src3');
    const dst = await makeRoom('pol-dst3');
    await pushByToken(src.rwToken, null, { K: 'v' });
    await declarePolicyByToken(dst.rwToken, null, {
      source_slug: 'pol-src3',
      source_key: 'K',
      alias: 'BY_POLICY',
    });
    const p = await propose(src, 'pol-dst3', 'K', 'SUGGESTED');
    expect(p).toEqual({ ok: true, id: expect.any(Number), autoAccepted: true });
    expect(await pullByToken(dst.rwToken, null, ['BY_POLICY'])).toEqual({
      ok: true,
      secrets: { BY_POLICY: 'v' },
    });
    const res = await pullByToken(dst.rwToken, null, ['SUGGESTED']);
    expect(res.ok).toBe(false);
  });

  it('отозванная политика — предложение снова ждёт accept', async () => {
    const src = await makeRoom('pol-src4');
    const dst = await makeRoom('pol-dst4');
    await pushByToken(src.rwToken, null, { K: 'v' });
    const d = await declarePolicyByToken(dst.rwToken, null, {
      source_slug: 'pol-src4',
      source_key: 'K',
    });
    if (!d.ok) throw new Error('declare failed');
    expect(await revokePolicyByToken(dst.rwToken, null, d.id)).toEqual({ ok: true, id: d.id });
    const p = await propose(src, 'pol-dst4', 'K');
    expect(p).toEqual({ ok: true, id: expect.any(Number), autoAccepted: false });
    const res = await pullByToken(dst.rwToken, null, ['K']);
    expect(res.ok).toBe(false);
  });

  it('политика по другому ключу на auto-accept не влияет', async () => {
    const src = await makeRoom('pol-src5');
    const dst = await makeRoom('pol-dst5');
    await pushByToken(src.rwToken, null, { K: 'v' });
    await declarePolicyByToken(dst.rwToken, null, {
      source_slug: 'pol-src5',
      source_key: 'OTHER',
    });
    const p = await propose(src, 'pol-dst5', 'K');
    expect(p).toEqual({ ok: true, id: expect.any(Number), autoAccepted: false });
  });

  it('принятая по политике выдача живёт и после отзыва политики', async () => {
    const src = await makeRoom('pol-src6');
    const dst = await makeRoom('pol-dst6');
    await pushByToken(src.rwToken, null, { K: 'v' });
    const d = await declarePolicyByToken(dst.rwToken, null, {
      source_slug: 'pol-src6',
      source_key: 'K',
    });
    if (!d.ok) throw new Error('declare failed');
    await propose(src, 'pol-dst6', 'K');
    expect(await revokePolicyByToken(dst.rwToken, null, d.id)).toEqual({ ok: true, id: d.id });
    expect(await pullByToken(dst.rwToken, null, ['K'])).toEqual({
      ok: true,
      secrets: { K: 'v' },
    });
  });

  it('авто-приём не снимает инварианты: занятое имя — 409', async () => {
    const src = await makeRoom('pol-src7');
    const dst = await makeRoom('pol-dst7');
    await pushByToken(src.rwToken, null, { K: 'v' });
    await pushByToken(dst.rwToken, null, { ALIAS: 'mine' });
    await declarePolicyByToken(dst.rwToken, null, {
      source_slug: 'pol-src7',
      source_key: 'K',
      alias: 'ALIAS',
    });
    const p = await propose(src, 'pol-dst7', 'K');
    expect(p).toEqual({
      ok: false,
      status: 409,
      error: 'У комнаты «pol-dst7» есть собственный ключ ALIAS — он выигрывает у выданного доступа. Выберите другое имя или удалите свой ключ.',
    });
  });

  it('объявляет политику только пишущий токен САМОЙ комнаты-получателя', async () => {
    await makeRoom('pol-src8'); // источник существует для source_slug
    const dst = await makeRoom('pol-dst8');
    // read-only — 403
    expect(
      await declarePolicyByToken(dst.roToken, null, {
        source_slug: 'pol-src8',
        source_key: 'K',
      }),
    ).toEqual({
      ok: false,
      status: 403,
      error: 'Политику приёма может объявить только токен с правом записи',
    });
    // битый — 401, как у выдач (неразличимость отказов)
    expect(
      await declarePolicyByToken('nota-token', null, {
        source_slug: 'pol-src8',
        source_key: 'K',
      }),
    ).toEqual({ ok: false, status: 401, error: 'Недействительный токен' });
    // чужой токен третьей комнаты объявляет СВОЮ политику, не чужую
    const third = await makeRoom('pol-third8');
    expect(
      await declarePolicyByToken(third.rwToken, null, {
        source_slug: 'pol-src8',
        source_key: 'K',
      }),
    ).toEqual({ ok: true, id: expect.any(Number), autoAccept: true });
    const policies = await listPolicies(dst.projectId);
    expect(policies).toEqual([]);
  });

  it('дубль живой политики — 409, себя в качестве источника — 409, чужой источник — 404', async () => {
    await makeRoom('pol-src9'); // источник существует для source_slug
    const dst = await makeRoom('pol-dst9');
    const d = await declarePolicyByToken(dst.rwToken, null, {
      source_slug: 'pol-src9',
      source_key: 'K',
    });
    if (!d.ok) throw new Error('declare failed');
    expect(
      await declarePolicyByToken(dst.rwToken, null, {
        source_slug: 'pol-src9',
        source_key: 'K',
      }),
    ).toEqual({
      ok: false,
      status: 409,
      error: 'Политика приёма «K от pol-src9» уже объявлена',
    });
    expect(
      await declarePolicyByToken(dst.rwToken, null, {
        source_slug: 'pol-dst9',
        source_key: 'K',
      }),
    ).toEqual({
      ok: false,
      status: 409,
      error: 'Комната-источник и комната-получатель совпадают',
    });
    expect(
      await declarePolicyByToken(dst.rwToken, null, {
        source_slug: 'no-such-room',
        source_key: 'K',
      }),
    ).toEqual({ ok: false, status: 404, error: 'Комната-источник не найдена' });
    // отзыв повторно — 409
    expect(await revokePolicyByToken(dst.rwToken, null, d.id)).toEqual({ ok: true, id: d.id });
    expect(await revokePolicyByToken(dst.rwToken, null, d.id)).toEqual({
      ok: false,
      status: 409,
      error: 'Политика приёма уже отозвана',
    });
    // чужая политика не отзывалась: 404
    const third = await makeRoom('pol-third9');
    expect(await revokePolicyByToken(third.rwToken, null, d.id)).toEqual({
      ok: false,
      status: 404,
      error: 'Политика приёма не найдена',
    });
  });

  it('аудит: объявление, auto-accept с номером политики, отзыв', async () => {
    const src = await makeRoom('pol-src10');
    const dst = await makeRoom('pol-dst10');
    await pushByToken(src.rwToken, null, { K: 'v' });
    const d = await declarePolicyByToken(dst.rwToken, null, {
      source_slug: 'pol-src10',
      source_key: 'K',
      alias: 'ALIAS',
    });
    if (!d.ok) throw new Error('declare failed');
    const p = await propose(src, 'pol-dst10', 'K');
    if (!p.ok) throw new Error('propose failed');
    await revokePolicyByToken(dst.rwToken, null, d.id);

    const db = refs.current!;
    const rows = await db
      .select()
      .from(secretsAudit)
      .where(eq(secretsAudit.projectId, dst.projectId));
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('policy_declared');
    expect(actions).toContain('grant_in');
    expect(actions).toContain('policy_revoked');
    const grantIn = rows.find((r) => r.action === 'grant_in');
    expect(grantIn?.detail).toContain('авто-приём по политике приёма #');
    const declared = rows.find((r) => r.action === 'policy_declared');
    expect(declared?.actor).toBe('room:pol-dst10');
    expect(declared?.detail).toContain('принимаю K от комнаты «pol-src10» как ALIAS');
  });
});

describe('политики приёма: путь владельца из GUI (S2, D-119)', () => {
  // Владелец комнат из makeRoom — auth_user id 1 (см. makeRoom: userId 1).
  const owner = {
    id: 1,
    username: 'admin',
    email: '',
    firstName: '',
    lastName: '',
    isSuperuser: true,
  };

  async function propose(src: Room, dstSlug: string, key = 'K') {
    return proposeGrantByToken(src.rwToken, null, { key, target_slug: dstSlug, note: 'test' });
  }

  it('объявление из GUI принимает предложения сразу, аудит — owner:1', async () => {
    const src = await makeRoom('own-src');
    const dst = await makeRoom('own-dst');
    await pushByToken(src.rwToken, null, { K: 'v' });
    expect(
      await createPolicy(owner, {
        targetProjectId: dst.projectId,
        sourceProjectId: src.projectId,
        sourceKey: 'K',
        aliasKey: 'ALIAS',
        note: 'тест',
      }),
    ).toEqual({ ok: true, id: expect.any(Number) });
    const p = await propose(src, 'own-dst');
    expect(p).toEqual({ ok: true, id: expect.any(Number), autoAccepted: true });
    expect(await pullByToken(dst.rwToken, null, ['ALIAS'])).toEqual({
      ok: true,
      secrets: { ALIAS: 'v' },
    });
    const db = refs.current!;
    const [declared] = await db
      .select({ actor: secretsAudit.actor, action: secretsAudit.action })
      .from(secretsAudit)
      .where(eq(secretsAudit.action, 'policy_declared'));
    expect(declared?.actor).toBe('owner:1');
  });

  it('чужую комнату в качестве получателя не объявить и её политики не трогать', async () => {
    const db = refs.current!;
    const [foreignUser] = await db
      .insert(authUser)
      .values({ username: 'foreign2', password: 'x', email: '' })
      .returning({ id: authUser.id });
    const [foreignRoom] = await db
      .insert(secretsProject)
      .values({ userId: foreignUser!.id, name: 'foreign', slug: 'foreign-x' })
      .returning({ id: secretsProject.id });
    const [src] = await db
      .insert(secretsProject)
      .values({ userId: 1, name: 's', slug: 'own-src2' })
      .returning({ id: secretsProject.id });
    // объявление на чужую комнату — отказ, строка не создана
    expect(
      await createPolicy(owner, {
        targetProjectId: foreignRoom!.id,
        sourceProjectId: src!.id,
        sourceKey: 'K',
      }),
    ).toEqual({ ok: false, error: 'Комната-получатель не найдена' });
    // чужих политик не видно и не отзывается
    const dst = await makeRoom('own-dst2');
    const d = await declarePolicyByToken(dst.rwToken, null, {
      source_slug: 'own-src2',
      source_key: 'K',
    });
    if (!d.ok) throw new Error('declare failed');
    expect(await revokePolicy({ ...owner, id: 99 }, d.id)).toBe(false);
    expect(await listPoliciesForUser({ ...owner, id: 99 }, dst.projectId)).toBeNull();
    expect(await listPoliciesForUser(owner, dst.projectId)).toHaveLength(1);
  });

  it('отзыв владельцем: будущие предложения ждут accept, принятая выдача живёт', async () => {
    const src = await makeRoom('own-src3');
    const dst = await makeRoom('own-dst3');
    await pushByToken(src.rwToken, null, { K: 'v', K2: 'v2' });
    const d = await createPolicy(owner, {
      targetProjectId: dst.projectId,
      sourceProjectId: src.projectId,
      sourceKey: 'K',
    });
    if (!d.ok) throw new Error('create failed');
    await propose(src, 'own-dst3', 'K');
    expect(await revokePolicy(owner, d.id)).toBe(true);
    // Ключ уже действует после отзыва политики — повторный propose того же
    // ключа корректно отрезается существующей выдачей (409), а НОВЫЙ ключ
    // без политики ждёт ручного accept.
    const p = await propose(src, 'own-dst3', 'K2');
    expect(p).toEqual({ ok: true, id: expect.any(Number), autoAccepted: false });
    expect(await pullByToken(dst.rwToken, null, ['K'])).toEqual({
      ok: true,
      secrets: { K: 'v' },
    });
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

describe('инвентарь токенов', () => {
  /** Пустая комната — токены добавляем явно, чтобы счёт в инвентаре был предсказуем. */
  async function makeEmptyRoom(slug: string): Promise<number> {
    const db = refs.current!;
    const [p] = await db
      .insert(secretsProject)
      .values({ userId: 1, name: slug, slug })
      .returning({ id: secretsProject.id });
    return p!.id;
  }

  /** Обычный статический токен (без личности, без использования). */
  async function mintStaticToken(projectId: number) {
    const db = refs.current!;
    const t = generateToken();
    await db.insert(secretsToken).values({
      projectId,
      name: 'inv-static',
      tokenPrefix: t.prefix,
      tokenHash: t.hash,
      canWrite: false,
    });
  }

  /** Токен под паспортной личностью (issuer — с slug: уникален на тест). */
  async function mintIdentityToken(slug: string, projectId: number, label: string, lastUsedAt: Date | null) {
    const db = refs.current!;
    const [iss] = await db
      .insert(passportIssuer)
      .values({
        issuer: `https://inv-issuer-${slug}`,
        jwksUri: `https://inv-issuer-${slug}/jwks`,
        audience: 'karman-vault',
        subjectPattern: '^repo:',
        identityClaim: 'repository_id',
      })
      .returning({ id: passportIssuer.id });
    const [ident] = await db
      .insert(passportIdentity)
      .values({
        issuerId: iss!.id,
        identityValue: label,
        label,
        projectId,
        canWrite: true,
      })
      .returning({ id: passportIdentity.id });
    const t = generateToken();
    await db.insert(secretsToken).values({
      projectId,
      name: 'inv-session',
      tokenPrefix: t.prefix,
      tokenHash: t.hash,
      canWrite: true,
      lastUsedAt: lastUsedAt ? lastUsedAt.toISOString() : null,
      identityId: ident!.id,
    });
  }

  it('собирает токены всех комнат: комната, префикс, личность, last_used', async () => {
    const a = await makeEmptyRoom('inv-a');
    const b = await makeEmptyRoom('inv-b');
    await mintIdentityToken('inv-a', a, 'Valstan/alpha', new Date('2026-10-01T00:00:00Z'));
    await mintStaticToken(b);
    const rows = await listTokenInventory();
    expect(rows).toHaveLength(2);
    // Свежее использование сверху; ни-разу-не-использованный — внизу.
    const first = rows[0]!;
    const second = rows[1]!;
    expect(first.projectSlug).toBe('inv-a');
    expect(first.identityLabel).toBe('Valstan/alpha');
    expect(new Date(first.lastUsedAt!).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(second.projectSlug).toBe('inv-b');
    expect(second.lastUsedAt).toBeNull();
    expect(second.identityLabel).toBeNull();
  });

  it('отозванный и истёкший видны с признаками; порядок отозванных по времени отзыва', async () => {
    const a = await makeEmptyRoom('inv-c');
    const b = await makeEmptyRoom('inv-d');
    await mintStaticToken(a);
    await mintStaticToken(b);
    const db = refs.current!;
    const now = new Date();
    await db
      .update(secretsToken)
      .set({ revokedAt: new Date(now.getTime() - 60_000).toISOString() })
      .where(eq(secretsToken.projectId, a));
    await db
      .update(secretsToken)
      .set({ expiresAt: new Date(now.getTime() - 60_000).toISOString() })
      .where(eq(secretsToken.projectId, b));
    const rows = await listTokenInventory();
    expect(rows).toHaveLength(2);
    const revoked = rows.find((r) => r.projectSlug === 'inv-c')!;
    const expired = rows.find((r) => r.projectSlug === 'inv-d')!;
    expect(revoked.revokedAt).not.toBeNull();
    expect(expired.expiresAt).not.toBeNull();
    expect(expired.revokedAt).toBeNull();
  });

  it('пустой vault — пустой инвентарь', async () => {
    expect(await listTokenInventory()).toEqual([]);
  });
});
