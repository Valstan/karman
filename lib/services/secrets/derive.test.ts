import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import { secretsAudit, secretsItem, secretsProject, secretsToken, authUser } from '@/lib/db/schema';
import {
  acceptGrantByToken,
  createToken,
  deleteItem,
  deleteProject,
  proposeGrantByToken,
  pullByToken,
  pushByToken,
  revokeGrantByToken,
  revokeToken,
  upsertItem,
} from '@/lib/services/secrets';
import {
  deriveSecretByToken,
  listDerivationsByToken,
  listHomesByToken,
  restoreDerivationByToken,
} from '@/lib/services/secrets/derive';
import { generateToken } from '@/lib/secrets/token';

/**
 * D-191 — производные секреты и их родословная (мандат brain 08.11, ADR-0015).
 *
 * Гейт по ТЕСТ-ПЛАНУ brain, а не по описанию реализации: каждая стража — отдельный
 * тест, и каждая проверяет наблюдаемое свойство (что увидит потребитель), а не
 * «функция вызвалась». Стражи brain'а:
 *
 *   1. Производная создаётся только при действующей выдаче; без неё — 403.
 *   2. Копия доступна в комнате получателя обычным чтением; в комнате источника — нет.
 *   3. Правка/удаление источника не трогает производную (она — новый секрет).
 *   4. Удаление источника помечает производные осиротевшими и пишет след в аудите;
 *      без явной команды копии живы.
 *   5. Чужую производную нельзя править/удалить: права — по комнате.
 *   6. `origin` виден владельцу данных источника в отчёте по производным.
 *
 * Плюс два из мандата 08.11 («копия помечена, но жива» и «копия не даёт доступа к
 * источнику») и решения brain 12.11: производную создаёт только пишущий токен,
 * отзыв токена комнаты-источника — не смерть источника (а «источник недоступен»).
 */
const refs = vi.hoisted(() => ({ current: undefined as TestDb | undefined }));
vi.mock('@/lib/db/client', () => ({
  get db() {
    return refs.current;
  },
}));

// Фикстура мастер-ключа: crypto читает env при каждом вызове.
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

let pg: PGlite | undefined;

beforeEach(async () => {
  const t = await createTestDb();
  pg = t.pg;
  refs.current = t.db;
  // Владелец (admin, id=1) засеян bootstrap'ом; добавляем второго — «чужого»,
  // чтобы проверять изоляцию прав по комнате (стража 5).
  await refs.current!
    .insert(authUser)
    .values({ id: 2, password: 'x', username: 'guest' } as never);
});

afterEach(async () => {
  refs.current = undefined;
  await pg?.close();
  pg = undefined;
});

type Room = { projectId: number; slug: string; rwToken: string; roToken: string; userId: number };

async function makeRoom(slug: string, userId = 1): Promise<Room> {
  const db = refs.current!;
  const [p] = await db
    .insert(secretsProject)
    .values({ userId, name: slug, slug })
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
  return {
    projectId: p!.id,
    slug,
    userId,
    rwToken: await mint(true),
    roToken: await mint(false),
  };
}

/** Владелец GUI: id пользователя, которому принадлежит комната. */
function ownerOf(userId: number) {
  return {
    id: userId,
    username: `owner${userId}`,
    email: '',
    firstName: '',
    lastName: '',
    isSuperuser: false,
  };
}

/** Выдача от источника получателю, принятая обеими руками (живая выдача). */
async function grantAccess(src: Room, dst: Room, key = 'K'): Promise<number> {
  const proposed = await proposeGrantByToken(src.rwToken, null, {
    key,
    target_slug: dst.slug,
    note: 'основание выдачи',
  });
  if (!proposed.ok) throw new Error(`propose failed: ${proposed.error}`);
  const accepted = await acceptGrantByToken(dst.rwToken, null, proposed.id);
  if (!accepted.ok) throw new Error(`accept failed: ${accepted.error}`);
  return proposed.id;
}

async function itemOf(room: Room, key: string) {
  const [row] = await refs.current!
    .select()
    .from(secretsItem)
    .where(and(eq(secretsItem.projectId, room.projectId), eq(secretsItem.key, key)))
    .limit(1);
  return row;
}

describe('D-191, стража 1: производная создаётся только по действующей выдаче', () => {
  it('без выдачи — 403, значение чужого ключа не копируется', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src' });

    const res = await deriveSecretByToken(dst.rwToken, null, {
      source_key: 'K',
      target_key: 'K_COPY',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
    const pulled = await pullByToken(dst.rwToken, null);
    expect(pulled.ok && pulled.secrets['K_COPY']).toBeUndefined();
  });

  it('с действующей выдачей — 201, копия лежит в комнате получателя', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src' });
    await grantAccess(src, dst);

    const res = await deriveSecretByToken(dst.rwToken, null, {
      source_key: 'K',
      target_key: 'K_COPY',
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.derived.origin_project_slug).toBe('src');
      expect(res.derived.origin_key).toBe('K');
    }
    const pulled = await pullByToken(dst.rwToken, null);
    expect(pulled.ok && pulled.secrets['K_COPY']).toBe('v-src');
  });

  it('отозванная выдача снова закрывает вывод (403)', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src' });
    const grantId = await grantAccess(src, dst);
    await revokeGrantByToken(src.rwToken, null, grantId);

    const res = await deriveSecretByToken(dst.rwToken, null, {
      source_key: 'K',
      target_key: 'K_COPY',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
  });

  it('read-only токен производную не выводит (403) — только пишущий', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src' });
    await grantAccess(src, dst);

    const res = await deriveSecretByToken(dst.roToken, null, {
      source_key: 'K',
      target_key: 'K_COPY',
    });
    expect(res).toEqual({
      ok: false,
      status: 403,
      error: 'Производную создаёт только токен с правом записи',
    });
  });
});

describe('D-191, стража 2: копия — секрет своей комнаты, чужим она не видна', () => {
  it('получатель читает копию обычным чтением, источник её не видит', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src' });
    await grantAccess(src, dst);
    await deriveSecretByToken(dst.rwToken, null, { source_key: 'K', target_key: 'K_COPY' });

    const inDst = await pullByToken(dst.rwToken, null);
    const inSrc = await pullByToken(src.rwToken, null);
    expect(inDst.ok && inDst.secrets['K_COPY']).toBe('v-src');
    expect(inSrc.ok && inSrc.secrets['K_COPY']).toBeUndefined();
  });

  it('копия не даёт доступа к источнику: без выдачи источник не читается', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src', OTHER: 'v-other' });
    const grantId = await grantAccess(src, dst);
    await deriveSecretByToken(dst.rwToken, null, { source_key: 'K', target_key: 'K_COPY' });

    // Выдачу отозвали — источник для получателя закрыт…
    await revokeGrantByToken(src.rwToken, null, grantId);
    const afterRevoke = await pullByToken(dst.rwToken, null);
    expect(afterRevoke.ok && afterRevoke.secrets['K']).toBeUndefined();
    expect(afterRevoke.ok && afterRevoke.secrets['OTHER']).toBeUndefined();
    // …а копия осталась: ради неё всё и затевалось.
    expect(afterRevoke.ok && afterRevoke.secrets['K_COPY']).toBe('v-src');
  });
});

describe('D-191, стража 3: правка источника не трогает производную', () => {
  it('источник перезаписан — копия хранит прежнее значение', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-old' });
    await grantAccess(src, dst);
    await deriveSecretByToken(dst.rwToken, null, { source_key: 'K', target_key: 'K_COPY' });

    await pushByToken(src.rwToken, null, { K: 'v-new' });

    const pulled = await pullByToken(dst.rwToken, null);
    expect(pulled.ok && pulled.secrets['K_COPY']).toBe('v-old');
    // А по выданному доступу видно уже новое значение — копия и выдача не одно и то же.
    expect(pulled.ok && pulled.secrets['K']).toBe('v-new');
  });
});

describe('D-191, стража 4: удаление источника помечает осиротевшими, копии живы', () => {
  it('пометка + след в аудите, значение копии остаётся', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src' });
    await grantAccess(src, dst);
    await deriveSecretByToken(dst.rwToken, null, { source_key: 'K', target_key: 'K_COPY' });

    const source = await itemOf(src, 'K');
    expect(await deleteItem(ownerOf(src.userId), source!.id)).toBe(true);

    // Копия жива: её значение по-прежнему читается.
    const pulled = await pullByToken(dst.rwToken, null);
    expect(pulled.ok && pulled.secrets['K_COPY']).toBe('v-src');

    // Пометка «источник умер» стоит.
    const list = await listDerivationsByToken(dst.rwToken, null);
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.derivations).toHaveLength(1);
      expect(list.derivations[0]).toMatchObject({
        key: 'K_COPY',
        origin_project_slug: 'src',
        origin_key: 'K',
        orphaned: true,
      });
    }

    // След в аудите комнаты копии — со списком домов.
    const audits = await refs.current!
      .select({ action: secretsAudit.action, detail: secretsAudit.detail })
      .from(secretsAudit)
      .where(eq(secretsAudit.action, 'secret_orphaned'));
    expect(audits.length).toBe(1);
    expect(audits[0]!.detail).toContain('dst/K_COPY');
  });

  it('удаление комнаты-источника помечает копии осиротевшими', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src' });
    await grantAccess(src, dst);
    await deriveSecretByToken(dst.rwToken, null, { source_key: 'K', target_key: 'K_COPY' });

    expect(await deleteProject(ownerOf(src.userId), src.projectId)).toBe(true);

    const list = await listDerivationsByToken(dst.rwToken, null);
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.derivations[0]!.orphaned).toBe(true);
      // Комната-источник удалена — ссылка обнулилась, но производная осталась.
      expect(list.derivations[0]!.origin_project_slug).toBe('(комната-источник удалена)');
    }
    const pulled = await pullByToken(dst.rwToken, null);
    expect(pulled.ok && pulled.secrets['K_COPY']).toBe('v-src');
  });

  it('пометку можно снять (restore) — и видно, жив ли источник', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src' });
    await grantAccess(src, dst);
    await deriveSecretByToken(dst.rwToken, null, { source_key: 'K', target_key: 'K_COPY' });
    const source = await itemOf(src, 'K');
    await deleteItem(ownerOf(src.userId), source!.id);

    const restored = await restoreDerivationByToken(dst.rwToken, null, { key: 'K_COPY' });
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.source_alive).toBe(false);

    const list = await listDerivationsByToken(dst.rwToken, null);
    expect(list.ok && list.derivations[0]!.orphaned).toBe(false);
  });

  it('restore без пишущего токена — 403', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src' });
    await grantAccess(src, dst);
    await deriveSecretByToken(dst.rwToken, null, { source_key: 'K', target_key: 'K_COPY' });
    const source = await itemOf(src, 'K');
    await deleteItem(ownerOf(src.userId), source!.id);

    const res = await restoreDerivationByToken(dst.roToken, null, { key: 'K_COPY' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
  });
});

describe('D-191, стража 5: чужая производная — нельзя править и нельзя удалить', () => {
  it('владелец чужой комнаты не удаляет и не правит копию', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src' });
    await grantAccess(src, dst);
    await deriveSecretByToken(dst.rwToken, null, { source_key: 'K', target_key: 'K_COPY' });

    const copy = await itemOf(dst, 'K_COPY');
    // Владелец комнаты-источника — не владелец копии.
    expect(await deleteItem(ownerOf(src.userId), copy!.id)).toBe(false);
    expect(
      await upsertItem(ownerOf(src.userId), {
        projectId: dst.projectId,
        key: 'K_COPY',
        value: 'подмена',
      }),
    ).toBe(false);

    const pulled = await pullByToken(dst.rwToken, null);
    expect(pulled.ok && pulled.secrets['K_COPY']).toBe('v-src');
  });

  it('свой секрет под именем выдачи производная не затирает (409)', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src' });
    await grantAccess(src, dst);

    const res = await deriveSecretByToken(dst.rwToken, null, {
      source_key: 'K',
      target_key: 'K',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });
});

describe('D-191, стража 6: родословная видна обеим сторонам', () => {
  it('владелец данных источника видит дома своего ключа', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src' });
    await grantAccess(src, dst);
    await deriveSecretByToken(dst.rwToken, null, { source_key: 'K', target_key: 'K_COPY' });

    const homes = await listHomesByToken(src.rwToken, null, 'K');
    expect(homes.ok).toBe(true);
    if (homes.ok) {
      expect(homes.homes).toHaveLength(1);
      expect(homes.homes[0]).toMatchObject({
        room: 'dst',
        key: 'K_COPY',
        orphaned: false,
      });
    }
  });

  it('получатель видит в своей копии, откуда она', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src' });
    await grantAccess(src, dst);
    await deriveSecretByToken(dst.rwToken, null, { source_key: 'K', target_key: 'K_COPY' });

    const list = await listDerivationsByToken(dst.rwToken, null);
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.derivations[0]).toMatchObject({
        key: 'K_COPY',
        origin_project_slug: 'src',
        origin_key: 'K',
        orphaned: false,
        source_unavailable: false,
      });
    }
  });

  it('реестр домов: в аудите источника есть строка «дом: комната X, ключ Y»', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src' });
    await grantAccess(src, dst);
    await deriveSecretByToken(dst.rwToken, null, { source_key: 'K', target_key: 'K_COPY' });

    const audits = await refs.current!
      .select({ projectId: secretsAudit.projectId, detail: secretsAudit.detail })
      .from(secretsAudit)
      .where(eq(secretsAudit.action, 'derivation_created'));
    expect(audits.length).toBe(1);
    expect(audits[0]!.projectId).toBe(src.projectId);
    expect(audits[0]!.detail).toContain('дом: комната dst, ключ K_COPY');
  });

  it('чужой ключ реестр домов не отдаёт (404)', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src' });
    await grantAccess(src, dst);
    await deriveSecretByToken(dst.rwToken, null, { source_key: 'K', target_key: 'K_COPY' });
    // «K» — ключ комнаты-источника. В комнате получателя такого ключа нет (выданное
    // имя — не запись), и спросить дома чужого ключа нельзя.
    const res = await listHomesByToken(dst.rwToken, null, 'K');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });
});

describe('D-191: отзыв токена комнаты-источника — не смерть источника', () => {
  it('последний токен отозван → «источник недоступен», но не orphaned', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src' });
    await grantAccess(src, dst);
    await deriveSecretByToken(dst.rwToken, null, { source_key: 'K', target_key: 'K_COPY' });

    // Отзываем ВСЕ токены комнаты-источника: комната стала недоступна.
    const tokens = await refs.current!
      .select({ id: secretsToken.id })
      .from(secretsToken)
      .where(eq(secretsToken.projectId, src.projectId));
    for (const t of tokens) {
      expect(await revokeToken(ownerOf(src.userId), t.id)).toBe(true);
    }

    const list = await listDerivationsByToken(dst.rwToken, null);
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.derivations[0]!.source_unavailable).toBe(true);
      expect(list.derivations[0]!.orphaned).toBe(false);
    }
    const audits = await refs.current!
      .select({ detail: secretsAudit.detail })
      .from(secretsAudit)
      .where(eq(secretsAudit.action, 'source_unavailable'));
    expect(audits.length).toBe(1);
    expect(audits[0]!.detail).toContain('dst/K_COPY');
  });

  it('новый токен у комнаты-источника снимает пометку «недоступен»', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src' });
    await grantAccess(src, dst);
    await deriveSecretByToken(dst.rwToken, null, { source_key: 'K', target_key: 'K_COPY' });
    const tokens = await refs.current!
      .select({ id: secretsToken.id })
      .from(secretsToken)
      .where(eq(secretsToken.projectId, src.projectId));
    for (const t of tokens) {
      await revokeToken(ownerOf(src.userId), t.id);
    }

    const minted = await createToken(ownerOf(src.userId), {
      projectId: src.projectId,
      name: 'новый',
      canWrite: true,
    });
    expect(minted).toBeTruthy();

    const list = await listDerivationsByToken(dst.rwToken, null);
    expect(list.ok && list.derivations[0]!.source_unavailable).toBe(false);
  });

  it('отзыв одного токена при живых соседях ничего не меняет', async () => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst', 2);
    await pushByToken(src.rwToken, null, { K: 'v-src' });
    await grantAccess(src, dst);
    await deriveSecretByToken(dst.rwToken, null, { source_key: 'K', target_key: 'K_COPY' });

    const tokens = await refs.current!
      .select({ id: secretsToken.id })
      .from(secretsToken)
      .where(eq(secretsToken.projectId, src.projectId));
    // У комнаты два токена (rw и ro) — отзыв одного оставляет комнату доступной.
    expect(await revokeToken(ownerOf(src.userId), tokens[0]!.id)).toBe(true);

    const list = await listDerivationsByToken(dst.rwToken, null);
    expect(list.ok && list.derivations[0]!.source_unavailable).toBe(false);
  });
});
