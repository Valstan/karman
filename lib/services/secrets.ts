import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  secretsProject,
  secretsItem,
  secretsToken,
  secretsAudit,
  secretsCard,
  secretsCardField,
} from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import {
  encryptSecret,
  decryptSecret,
  secretAad,
  cardTitleAad,
  cardFieldAad,
} from '@/lib/secrets/crypto';
import { generateToken, hashToken, looksLikeToken } from '@/lib/secrets/token';
import type {
  SecretProjectCreateInput,
  SecretProjectUpdateInput,
  SecretItemUpsertInput,
  SecretTokenCreateInput,
  SecretCardCreateInput,
  SecretCardUpdateInput,
  SecretCardFieldUpsertInput,
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
  canWrite: boolean;
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
      canWrite: secretsToken.canWrite,
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

// --- Карточки секретов (vault Ф1) --------------------------------------------

export type SecretCardFieldMeta = { id: number; name: string; kind: string; position: number };
export type SecretCardListItem = {
  id: number;
  envKey: string | null;
  title: string;
  fields: SecretCardFieldMeta[];
  updatedAt: string;
};

/**
 * Карточки комнаты с расшифрованными наименованиями и метаданными полей
 * (значения полей НЕ возвращаются — расшифровка по клику через revealCardField).
 */
export async function listCards(user: SessionUser, projectId: number): Promise<SecretCardListItem[] | null> {
  if ((await ownedProjectId(user, projectId)) === null) return null;
  const cards = await db
    .select()
    .from(secretsCard)
    .where(eq(secretsCard.projectId, projectId))
    .orderBy(desc(secretsCard.id));
  if (cards.length === 0) return [];

  const fields = await db
    .select({
      id: secretsCardField.id,
      cardId: secretsCardField.cardId,
      name: secretsCardField.name,
      kind: secretsCardField.kind,
      position: secretsCardField.position,
    })
    .from(secretsCardField)
    .innerJoin(secretsCard, eq(secretsCardField.cardId, secretsCard.id))
    .where(eq(secretsCard.projectId, projectId))
    .orderBy(secretsCardField.position, secretsCardField.id);

  return cards.map((c) => ({
    id: c.id,
    envKey: c.envKey,
    title: decryptSecret({ ciphertext: c.titleCt, iv: c.titleIv, authTag: c.titleTag }, cardTitleAad(c.id)),
    fields: fields.filter((f) => f.cardId === c.id).map(({ cardId: _cardId, ...f }) => f),
    updatedAt: c.updatedAt,
  }));
}

/**
 * Создаёт карточку. Наименование шифруется с AAD от id карточки, поэтому
 * insert и шифрование идут в одной транзакции (insert плейсхолдера → update).
 */
export async function createCard(user: SessionUser, input: SecretCardCreateInput): Promise<number | null> {
  if ((await ownedProjectId(user, input.projectId)) === null) return null;
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(secretsCard)
      .values({ projectId: input.projectId, envKey: input.envKey ?? null, titleCt: '', titleIv: '', titleTag: '' })
      .returning({ id: secretsCard.id });
    const id = created!.id;
    const enc = encryptSecret(input.title, cardTitleAad(id));
    await tx
      .update(secretsCard)
      .set({ titleCt: enc.ciphertext, titleIv: enc.iv, titleTag: enc.authTag })
      .where(eq(secretsCard.id, id));
    return id;
  });
}

/** id карточки, если её комната принадлежит пользователю; иначе null. */
async function ownedCardId(user: SessionUser, cardId: number): Promise<number | null> {
  const [row] = await db
    .select({ id: secretsCard.id })
    .from(secretsCard)
    .innerJoin(secretsProject, eq(secretsCard.projectId, secretsProject.id))
    .where(and(eq(secretsCard.id, cardId), ownership(user, secretsProject.userId)))
    .limit(1);
  return row?.id ?? null;
}

export async function updateCard(user: SessionUser, input: SecretCardUpdateInput): Promise<boolean> {
  if ((await ownedCardId(user, input.id)) === null) return false;
  const enc = encryptSecret(input.title, cardTitleAad(input.id));
  await db
    .update(secretsCard)
    .set({
      envKey: input.envKey ?? null,
      titleCt: enc.ciphertext,
      titleIv: enc.iv,
      titleTag: enc.authTag,
      updatedAt: isoNow(),
    })
    .where(eq(secretsCard.id, input.id));
  return true;
}

export async function deleteCard(user: SessionUser, cardId: number): Promise<boolean> {
  if ((await ownedCardId(user, cardId)) === null) return false;
  await db.delete(secretsCard).where(eq(secretsCard.id, cardId));
  return true;
}

/** Создаёт/обновляет поле карточки (по уникальному (card_id, name)). */
export async function upsertCardField(user: SessionUser, input: SecretCardFieldUpsertInput): Promise<boolean> {
  if ((await ownedCardId(user, input.cardId)) === null) return false;
  const enc = encryptSecret(input.value, cardFieldAad(input.cardId, input.name));
  const [posRow] = await db
    .select({ maxPos: sql<number>`coalesce(max(position), 0)::int` })
    .from(secretsCardField)
    .where(eq(secretsCardField.cardId, input.cardId));
  const maxPos = posRow?.maxPos ?? 0;
  await db
    .insert(secretsCardField)
    .values({
      cardId: input.cardId,
      name: input.name,
      kind: input.kind,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      position: maxPos + 1,
    })
    .onConflictDoUpdate({
      target: [secretsCardField.cardId, secretsCardField.name],
      set: { kind: input.kind, ciphertext: enc.ciphertext, iv: enc.iv, authTag: enc.authTag, updatedAt: isoNow() },
    });
  await db.update(secretsCard).set({ updatedAt: isoNow() }).where(eq(secretsCard.id, input.cardId));
  return true;
}

export async function deleteCardField(user: SessionUser, fieldId: number): Promise<boolean> {
  const [field] = await db
    .select({ id: secretsCardField.id, cardId: secretsCardField.cardId })
    .from(secretsCardField)
    .where(eq(secretsCardField.id, fieldId))
    .limit(1);
  if (!field || (await ownedCardId(user, field.cardId)) === null) return false;
  await db.delete(secretsCardField).where(eq(secretsCardField.id, fieldId));
  return true;
}

/** Расшифровывает значение поля карточки (показ владельцу по клику). null — нет доступа. */
export async function revealCardField(user: SessionUser, fieldId: number): Promise<string | null> {
  const [field] = await db
    .select({
      cardId: secretsCardField.cardId,
      name: secretsCardField.name,
      ciphertext: secretsCardField.ciphertext,
      iv: secretsCardField.iv,
      authTag: secretsCardField.authTag,
    })
    .from(secretsCardField)
    .where(eq(secretsCardField.id, fieldId))
    .limit(1);
  if (!field || (await ownedCardId(user, field.cardId)) === null) return null;
  return decryptSecret(field, cardFieldAad(field.cardId, field.name));
}

// --- Токены доступа ---------------------------------------------------------

/** Создаёт токен; возвращает сам токен ОДИН раз (в БД только хэш). null — нет доступа. */
export async function createToken(
  user: SessionUser,
  input: SecretTokenCreateInput,
): Promise<string | null> {
  if ((await ownedProjectId(user, input.projectId)) === null) return null;
  const t = generateToken();
  await db.insert(secretsToken).values({
    projectId: input.projectId,
    name: input.name,
    tokenPrefix: t.prefix,
    tokenHash: t.hash,
    canWrite: input.canWrite,
  });
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

export type PushResult =
  | { ok: true; written: number }
  | { ok: false; status: 401 | 403 | 500; error: string };

/**
 * Записывает (upsert) секреты в проект токена. Требует токен с `can_write`.
 * Проверяет токен по хэшу, шифрует значения, пишет аудит, обновляет last_used_at.
 */
export async function pushByToken(
  rawToken: string,
  ip: string | null,
  secrets: Record<string, string>,
): Promise<PushResult> {
  if (!looksLikeToken(rawToken)) {
    await logAudit(null, null, 'push_denied', 'некорректный формат токена', ip);
    return { ok: false, status: 401, error: 'Недействительный токен' };
  }
  const [tok] = await db
    .select({
      id: secretsToken.id,
      projectId: secretsToken.projectId,
      revokedAt: secretsToken.revokedAt,
      canWrite: secretsToken.canWrite,
    })
    .from(secretsToken)
    .where(eq(secretsToken.tokenHash, hashToken(rawToken)))
    .limit(1);
  if (!tok || tok.revokedAt) {
    await logAudit(tok?.projectId ?? null, tok?.id ?? null, 'push_denied', tok ? 'токен отозван' : 'неизвестный токен', ip);
    return { ok: false, status: 401, error: 'Недействительный токен' };
  }
  if (!tok.canWrite) {
    await logAudit(tok.projectId, tok.id, 'push_denied', 'токен только для чтения', ip);
    return { ok: false, status: 403, error: 'Токен не имеет прав записи' };
  }

  const entries = Object.entries(secrets);
  try {
    for (const [key, value] of entries) {
      const enc = encryptSecret(value, secretAad(tok.projectId, key));
      await db
        .insert(secretsItem)
        .values({
          projectId: tok.projectId,
          key,
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          authTag: enc.authTag,
        })
        .onConflictDoUpdate({
          target: [secretsItem.projectId, secretsItem.key],
          set: { ciphertext: enc.ciphertext, iv: enc.iv, authTag: enc.authTag, updatedAt: isoNow() },
        });
    }
    await db.update(secretsToken).set({ lastUsedAt: isoNow() }).where(eq(secretsToken.id, tok.id));
    await logAudit(tok.projectId, tok.id, 'push', `${entries.length} ключей`, ip);
    return { ok: true, written: entries.length };
  } catch {
    await logAudit(tok.projectId, tok.id, 'push_error', 'ошибка шифрования/записи (мастер-ключ?)', ip);
    return { ok: false, status: 500, error: 'Сервис секретов недоступен' };
  }
}
