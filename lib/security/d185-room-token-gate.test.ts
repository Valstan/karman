import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import { secretsProject, secretsToken } from '@/lib/db/schema';
import {
  acceptGrantByToken,
  declarePolicyByToken,
  proposeGrantByToken,
  pullByToken,
  pushByToken,
  revokeGrantByToken,
  revokePolicyByToken,
} from '@/lib/services/secrets';
import { listTokenInventory } from '@/lib/services/secrets';
import {
  deriveSecretByToken,
  restoreDerivationByToken,
} from '@/lib/services/secrets/derive';
import { claimBootstrap } from '@/lib/services/bootstrap';
import { generateToken, hashToken } from '@/lib/secrets/token';

/**
 * G593 — «постоянный read-only токен не ломает политику приёма» (D-185).
 *
 * Мандат brain (12.11): «проверка "не ломает ли политику приёма" будет **гейтом**, который
 * перечисляет все пути записи (записать / предложить выдачу / принять выдачу) и падает на
 * каждом».
 *
 * Здесь ровно два свойства, а не пересказ чужих тестов:
 *
 * 1. **Полнота.** Таблица путей записи сверяется с РОУТАМИ НА ДИСКЕ: новый путь записи
 *    в подсистеме комнатных токенов, не попавший в таблицу, роняет гейт. Иначе
 *    «перечислить все пути» — это перечисление на память, а проверка на память не гейт.
 * 2. **Падение на каждом.** Каждый путь под токеном комнаты — отдельный кейс с
 *    конкретным ожиданием: read-only токен обязан получить отказ (403), остальные пути
 *    закрыты своим носителем (временный код, ключ provisioning, паспортная личность).
 *
 * Плюс инварианты самого постоянного RO-токена, из-за которых он и опаснее: он вечен, его
 * использование видно, его отзыв виден, и он НЕ становится участником приёма (не может
 * объявить политику и не может принять выдачу).
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

const ROOT = join(__dirname, '..', '..');
const SECRETS_ROUTES = join(ROOT, 'app', 'api', 'secrets');

/** Чем закрыт путь: токеном комнаты, временным кодом, ключом provisioning или паспортом. */
type AuthKind =
  | 'room-token'
  | 'room-token-self'
  | 'bootstrap-code'
  | 'provision-key'
  | 'passport-claim';

type WritePath = {
  /** Роут в виде `МЕТОД /путь` — как он идёт в write-paths.md. */
  route: string;
  /** Что путь делает — по-человечески, для таблицы гейта. */
  op: string;
  /** Чем закрыт. */
  auth: AuthKind;
};

/**
 * ТАБЛИЦА ПУТЕЙ ЗАПИСИ подсистемы комнатных токенов.
 *
 * Это и есть «перечисление всех путей записи» из G593: новый путь добавляется сюда
 * строкой — иначе гейт падает на сверке с роутами на диске.
 */
const WRITE_PATHS: WritePath[] = [
  { route: 'POST /api/secrets', op: 'записать секрет в комнату', auth: 'room-token' },
  { route: 'POST /api/secrets/claim', op: 'обменять времянку на токен', auth: 'bootstrap-code' },
  { route: 'POST /api/secrets/grants', op: 'предложить выдачу', auth: 'room-token' },
  { route: 'DELETE /api/secrets/grants', op: 'отозвать выдачу', auth: 'room-token' },
  { route: 'POST /api/secrets/grants/[id]/accept', op: 'принять выдачу', auth: 'room-token' },
  { route: 'POST /api/secrets/policies', op: 'объявить политику приёма', auth: 'room-token' },
  { route: 'DELETE /api/secrets/policies', op: 'отозвать политику приёма', auth: 'room-token' },
  { route: 'POST /api/secrets/provision', op: 'завести комнату (self-serve)', auth: 'provision-key' },
  { route: 'POST /api/secrets/session', op: 'открыть паспортную сессию', auth: 'passport-claim' },
  {
    route: 'DELETE /api/secrets/session',
    op: 'закрыть паспортную сессию (своим токеном)',
    auth: 'room-token-self',
  },
  {
    route: 'POST /api/secrets/derive',
    op: 'вывести производную (копию чужого ключа к себе)',
    auth: 'room-token',
  },
  {
    route: 'POST /api/secrets/derivations/restore',
    op: 'снять пометку «источник умер» с производной',
    auth: 'room-token',
  },
];

/** Роут → методы записи, которые в нём есть (из исходника, а не из списка). */
function writeRoutesOnDisk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...writeRoutesOnDisk(full));
      continue;
    }
    if (entry !== 'route.ts') continue;
    const source = readFileSync(full, 'utf8');
    const rel = relative(join(ROOT, 'app', 'api'), full).split(sep).join('/');
    const path = `/api/${rel.replace(/\/?route\.ts$/, '')}`;
    for (const method of source.matchAll(/export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\s*\(/g)) {
      out.push(`${method[1]} ${path}`);
    }
  }
  return out.sort();
}

type Room = { projectId: number; slug: string; rwToken: string; roToken: string; roPrefix: string };

async function makeRoom(slug: string): Promise<Room> {
  const db = refs.current!;
  const [p] = await db
    .insert(secretsProject)
    .values({ userId: 1, name: slug, slug })
    .returning({ id: secretsProject.id });
  async function mint(canWrite: boolean): Promise<{ token: string; prefix: string }> {
    const t = generateToken();
    await db.insert(secretsToken).values({
      projectId: p!.id,
      name: 'test',
      tokenPrefix: t.prefix,
      tokenHash: t.hash,
      canWrite,
    });
    return { token: t.token, prefix: t.prefix };
  }
  const rw = await mint(true);
  const ro = await mint(false);
  return { projectId: p!.id, slug, rwToken: rw.token, roToken: ro.token, roPrefix: ro.prefix };
}

beforeEach(async () => {
  const t = await createTestDb();
  pg = t.pg;
  refs.current = t.db;
});

afterEach(async () => {
  refs.current = undefined;
  await pg?.close();
  pg = undefined;
});

describe('G593: все пути записи подсистемы перечислены', () => {
  it('таблица совпадает с роутами на диске — новый путь без строки роняет гейт', () => {
    const onDisk = writeRoutesOnDisk(SECRETS_ROUTES);
    const inTable = WRITE_PATHS.map((p) => p.route).sort();
    expect(onDisk).toEqual(inTable);
  });
});

describe('G593: read-only токен не проходит ни один путь записи', () => {
  const roomTokenPaths = WRITE_PATHS.filter((p) => p.auth === 'room-token').map((p) => p.route);

  it.each(roomTokenPaths)('%s — отказ 403', async (route) => {
    const src = await makeRoom('src');
    const dst = await makeRoom('dst');
    await pushByToken(src.rwToken, null, { K: 'v' });
    const grant = await proposeGrantByToken(src.rwToken, null, {
      key: 'K',
      target_slug: 'dst',
      note: 't',
    });
    if (!grant.ok) throw new Error('propose failed');
    const policy = await declarePolicyByToken(dst.rwToken, null, {
      source_slug: 'src',
      source_key: 'K',
    });
    if (!policy.ok) throw new Error('declare failed');

    const result = await runWritePath(route, src, grant.id, policy.id);

    expect(result.status, `путь ${route} обязан отказать read-only токену`).toBe(403);
  });

  it('путь, закрытый временным кодом, не пускает токен комнаты (401)', async () => {
    const room = await makeRoom('claim-room');
    const result = await claimBootstrap(room.roToken, '127.0.0.1');
    // Токен комнаты — не код: формат другой, отказ неразличим от «неизвестного кода».
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });
});

describe('G593: инварианты постоянного read-only токена', () => {
  it('он вечен: срока нет, и в инвентаре виден как «живой»', async () => {
    const room = await makeRoom('inv-ro');
    const [row] = await refs.current!
      .select()
      .from(secretsToken)
      .where(eq(secretsToken.tokenHash, hashToken(room.roToken)))
      .limit(1);
    expect(row!.expiresAt).toBeNull();

    const inventory = await listTokenInventory();
    const entry = inventory.find((e) => e.tokenPrefix === room.roPrefix);
    expect(entry).toBeDefined();
    expect(entry!.canWrite).toBe(false);
    expect(entry!.revokedAt).toBeNull();
  });

  it('использование видно: last_used растёт при обращении', async () => {
    const room = await makeRoom('used-ro');
    const before = await listTokenInventory();
    const entryBefore = before.find((e) => e.tokenPrefix === room.roPrefix)!;
    expect(entryBefore.lastUsedAt).toBeNull();

    await pullByToken(room.roToken, null);

    const after = await listTokenInventory();
    const entryAfter = after.find((e) => e.tokenPrefix === room.roPrefix)!;
    expect(entryAfter.lastUsedAt).not.toBeNull();
  });

  it('отзыв виден сразу в инвентаре', async () => {
    const room = await makeRoom('revoke-ro');
    const [row] = await refs.current!
      .select()
      .from(secretsToken)
      .where(eq(secretsToken.tokenHash, hashToken(room.roToken)))
      .limit(1);
    await refs.current!
      .update(secretsToken)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(secretsToken.id, row!.id));

    const inventory = await listTokenInventory();
    const entry = inventory.find((e) => e.tokenPrefix === room.roPrefix)!;
    expect(entry.revokedAt).not.toBeNull();
    // И токен больше не читает.
    const res = await pullByToken(room.roToken, null);
    expect(res.ok).toBe(false);
  });

  it('RO не становится участником приёма: политику не объявляет и выдачу не принимает', async () => {
    const src = await makeRoom('pol-src');
    const dst = await makeRoom('pol-dst');
    const grant = await proposeGrantByToken(src.rwToken, null, {
      key: 'K',
      target_slug: 'pol-dst',
      note: 't',
    });
    if (!grant.ok) throw new Error('propose failed');

    const declare = await declarePolicyByToken(dst.roToken, null, {
      source_slug: 'pol-src',
      source_key: 'K',
    });
    expect(declare).toEqual({
      ok: false,
      status: 403,
      error: 'Политику приёма может объявить только токен с правом записи',
    });

    const accept = await acceptGrantByToken(dst.roToken, null, grant.id);
    expect(accept).toEqual({
      ok: false,
      status: 403,
      error: 'Выдавать доступ может только токен с правом записи',
    });
  });
});

/**
 * Прогон одного пути записи read-only токеном — по таблице выше.
 * Каждый путь под токеном комнаты обязан отказать одинаково: 403 «нужен токен с правом
 * записи».
 */
async function runWritePath(
  route: string,
  src: Room,
  grantId: number,
  policyId: number,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  switch (route) {
    case 'POST /api/secrets':
      return pushByToken(src.roToken, null, { K: 'v' });
    case 'POST /api/secrets/grants':
      return proposeGrantByToken(src.roToken, null, {
        key: 'K',
        target_slug: 'dst',
        note: 't',
      });
    case 'DELETE /api/secrets/grants':
      return revokeGrantByToken(src.roToken, null, grantId);
    case 'POST /api/secrets/grants/[id]/accept':
      return acceptGrantByToken(src.roToken, null, grantId);
    case 'POST /api/secrets/policies':
      return declarePolicyByToken(src.roToken, null, {
        source_slug: 'src',
        source_key: 'K',
      });
    case 'DELETE /api/secrets/policies':
      return revokePolicyByToken(src.roToken, null, policyId);
    case 'POST /api/secrets/derive':
      // Производную выводят по действующей выдаче; read-only токен не может.
      return deriveSecretByToken(src.roToken, null, { source_key: 'K', target_key: 'COPY' });
    case 'POST /api/secrets/derivations/restore':
      return restoreDerivationByToken(src.roToken, null, { key: 'COPY' });
    default:
      throw new Error(`путь ${route} не покрыт прогоном`);
  }
}
