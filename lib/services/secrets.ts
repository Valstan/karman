import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { secretsProject, secretsItem, secretsToken, secretsAudit } from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import { encryptSecret, decryptSecret, secretAad } from '@/lib/secrets/crypto';
import { generateToken, hashToken, looksLikeToken } from '@/lib/secrets/token';
import type {
  SecretProjectCreateInput,
  SecretProjectUpdateInput,
  SecretItemUpsertInput,
  SecretTokenCreateInput,
} from '@/lib/validation/secret';

export type SecretProjectListItem = {
  id: number;
  name: string;
  slug: string;
  itemCount: number;
  tokenCount: number;
  createdAt: string;
};

export type SecretItemMeta = { id: number; key: string; updatedAt: string };
export type SecretTokenMeta = {
  id: number;
  name: string;
  tokenPrefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};
export type SecretAuditEntry = {
  action: string;
  detail: string | null;
  ip: string | null;
  at: string;
};
export type SecretProjectDetail = {
  project: { id: number; name: string; slug: string };
  items: SecretItemMeta[];
  tokens: SecretTokenMeta[];
  audit: SecretAuditEntry[];
};

const isoNow = () => new Date().toISOString();

/** id проекта, если он принадлежит пользователю (или он superuser); иначе null. */
async function ownedProjectId(user: SessionUser, projectId: number): Promise<number | null> {
  const [row] = await db
    .select({ id: secretsProject.id })
    .from(secretsProject)
    .where(and(eq(secretsProject.id, projectId), ownership(user, secretsProject.userId)))
    .limit(1);
  return row?.id ?? null;
}

async function logAudit(
  projectId: number | null,
  tokenId: number | null,
  action: string,
  detail: string | null,
  ip: string | null,
): Promise<void> {
  await db.insert(secretsAudit).values({ projectId, tokenId, action, detail, ip });
}

// --- Проекты (UI владельца) -------------------------------------------------

export async function listProjects(user: SessionUser): Promise<SecretProjectListItem[]> {
  return db
    .select({
      id: secretsProject.id,
      name: secretsProject.name,
      slug: secretsProject.slug,
      createdAt: secretsProject.createdAt,
      itemCount: sql<number>`(select count(*)::int from secrets_item where project_id = ${secretsProject.id})`,
      tokenCount: sql<number>`(select count(*)::int from secrets_token where project_id = ${secretsProject.id} and revoked_at is null)`,
    })
    .from(secretsProject)
    .where(ownership(user, secretsProject.userId))
    .orderBy(desc(secretsProject.id));
}

export async function createProject(user: SessionUser, input: SecretProjectCreateInput): Promise<number> {
  const [created] = await db
    .insert(secretsProject)
    .values({ userId: user.id, name: input.name, slug: input.slug })
    .returning({ id: secretsProject.id });
  return created!.id;
}

export async function updateProject(user: SessionUser, input: SecretProjectUpdateInput): Promise<boolean> {
  const result = await db
    .update(secretsProject)
    .set({ name: input.name, slug: input.slug, updatedAt: isoNow() })
    .where(and(eq(secretsProject.id, input.id), ownership(user, secretsProject.userId)))
    .returning({ id: secretsProject.id });
  return result.length > 0;
}

export async function deleteProject(user: SessionUser, id: number): Promise<boolean> {
  const result = await db
    .delete(secretsProject)
    .where(and(eq(secretsProject.id, id), ownership(user, secretsProject.userId)))
    .returning({ id: secretsProject.id });
  return result.length > 0;
}

export async function getProjectDetail(
  user: SessionUser,
  projectId: number,
): Promise<SecretProjectDetail | null> {
  const [project] = await db
    .select({ id: secretsProject.id, name: secretsProject.name, slug: secretsProject.slug })
    .from(secretsProject)
    .where(and(eq(secretsProject.id, projectId), ownership(user, secretsProject.userId)))
    .limit(1);
  if (!project) return null;

  const items = await db
    .select({ id: secretsItem.id, key: secretsItem.key, updatedAt: secretsItem.updatedAt })
    .from(secretsItem)
    .where(eq(secretsItem.projectId, projectId))
    .orderBy(secretsItem.key);

  const tokens = await db
    .select({
      id: secretsToken.id,
      name: secretsToken.name,
      tokenPrefix: secretsToken.tokenPrefix,
      lastUsedAt: secretsToken.lastUsedAt,
      revokedAt: secretsToken.revokedAt,
      createdAt: secretsToken.createdAt,
    })
    .from(secretsToken)
    .where(eq(secretsToken.projectId, projectId))
    .orderBy(desc(secretsToken.id));

  const audit = await db
    .select({
      action: secretsAudit.action,
      detail: secretsAudit.detail,
      ip: secretsAudit.ip,
      at: secretsAudit.at,
    })
    .from(secretsAudit)
    .where(eq(secretsAudit.projectId, projectId))
    .orderBy(desc(secretsAudit.id))
    .limit(20);

  return { project, items, tokens, audit };
}

// --- Секреты ----------------------------------------------------------------

/** Создаёт/обновляет секрет (по уникальному (project_id, key)). Шифрует значение. */
export async function upsertItem(user: SessionUser, input: SecretItemUpsertInput): Promise<boolean> {
  if ((await ownedProjectId(user, input.projectId)) === null) return false;
  const enc = encryptSecret(input.value, secretAad(input.projectId, input.key));
  await db
    .insert(secretsItem)
    .values({
      projectId: input.projectId,
      key: input.key,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
    })
    .onConflictDoUpdate({
      target: [secretsItem.projectId, secretsItem.key],
      set: { ciphertext: enc.ciphertext, iv: enc.iv, authTag: enc.authTag, updatedAt: isoNow() },
    });
  return true;
}

export async function deleteItem(user: SessionUser, itemId: number): Promise<boolean> {
  // Удаляем только если родительский проект принадлежит пользователю.
  const [item] = await db
    .select({ id: secretsItem.id, projectId: secretsItem.projectId })
    .from(secretsItem)
    .where(eq(secretsItem.id, itemId))
    .limit(1);
  if (!item || (await ownedProjectId(user, item.projectId)) === null) return false;
  await db.delete(secretsItem).where(eq(secretsItem.id, itemId));
  return true;
}

/** Расшифровывает одно значение (для показа владельцу по клику). null — нет доступа. */
export async function revealItem(user: SessionUser, itemId: number): Promise<string | null> {
  const [item] = await db
    .select({
      projectId: secretsItem.projectId,
      key: secretsItem.key,
      ciphertext: secretsItem.ciphertext,
      iv: secretsItem.iv,
      authTag: secretsItem.authTag,
    })
    .from(secretsItem)
    .where(eq(secretsItem.id, itemId))
    .limit(1);
  if (!item || (await ownedProjectId(user, item.projectId)) === null) return null;
  return decryptSecret(item, secretAad(item.projectId, item.key));
}

// --- Токены доступа ---------------------------------------------------------

/** Создаёт токен; возвращает сам токен ОДИН раз (в БД только хэш). null — нет доступа. */
export async function createToken(
  user: SessionUser,
  input: SecretTokenCreateInput,
): Promise<string | null> {
  if ((await ownedProjectId(user, input.projectId)) === null) return null;
  const t = generateToken();
  await db
    .insert(secretsToken)
    .values({ projectId: input.projectId, name: input.name, tokenPrefix: t.prefix, tokenHash: t.hash });
  return t.token;
}

export async function revokeToken(user: SessionUser, tokenId: number): Promise<boolean> {
  const [tok] = await db
    .select({ id: secretsToken.id, projectId: secretsToken.projectId })
    .from(secretsToken)
    .where(eq(secretsToken.id, tokenId))
    .limit(1);
  if (!tok || (await ownedProjectId(user, tok.projectId)) === null) return false;
  await db.update(secretsToken).set({ revokedAt: isoNow() }).where(eq(secretsToken.id, tokenId));
  return true;
}

// --- Машинный доступ по токену (API, без сессии) ----------------------------

export type PullResult =
  | { ok: true; secrets: Record<string, string> }
  | { ok: false; status: 401 | 404 | 500; error: string };

/**
 * Выдаёт секреты проекта по токену (plaintext). Проверяет токен по хэшу, пишет
 * аудит, обновляет last_used_at. keyFilter — вернуть один ключ (или 404).
 */
export async function pullByToken(
  rawToken: string,
  ip: string | null,
  keyFilter?: string,
): Promise<PullResult> {
  if (!looksLikeToken(rawToken)) {
    await logAudit(null, null, 'pull_denied', 'некорректный формат токена', ip);
    return { ok: false, status: 401, error: 'Недействительный токен' };
  }
  const [tok] = await db
    .select({
      id: secretsToken.id,
      projectId: secretsToken.projectId,
      revokedAt: secretsToken.revokedAt,
    })
    .from(secretsToken)
    .where(eq(secretsToken.tokenHash, hashToken(rawToken)))
    .limit(1);
  if (!tok || tok.revokedAt) {
    await logAudit(tok?.projectId ?? null, tok?.id ?? null, 'pull_denied', tok ? 'токен отозван' : 'неизвестный токен', ip);
    return { ok: false, status: 401, error: 'Недействительный токен' };
  }

  let rows;
  try {
    rows = await db
      .select({
        key: secretsItem.key,
        ciphertext: secretsItem.ciphertext,
        iv: secretsItem.iv,
        authTag: secretsItem.authTag,
      })
      .from(secretsItem)
      .where(eq(secretsItem.projectId, tok.projectId));

    const secrets: Record<string, string> = {};
    for (const r of rows) {
      secrets[r.key] = decryptSecret(r, secretAad(tok.projectId, r.key));
    }

    await db.update(secretsToken).set({ lastUsedAt: isoNow() }).where(eq(secretsToken.id, tok.id));

    if (keyFilter !== undefined) {
      if (!(keyFilter in secrets)) {
        await logAudit(tok.projectId, tok.id, 'pull_miss', keyFilter, ip);
        return { ok: false, status: 404, error: 'Ключ не найден' };
      }
      await logAudit(tok.projectId, tok.id, 'pull', `key=${keyFilter}`, ip);
      return { ok: true, secrets: { [keyFilter]: secrets[keyFilter]! } };
    }

    await logAudit(tok.projectId, tok.id, 'pull', `${rows.length} ключей`, ip);
    return { ok: true, secrets };
  } catch {
    // Например, SECRETS_MASTER_KEY не задан/неверен — расшифровка невозможна.
    await logAudit(tok.projectId, tok.id, 'pull_error', 'ошибка расшифровки (мастер-ключ?)', ip);
    return { ok: false, status: 500, error: 'Сервис секретов недоступен' };
  }
}
