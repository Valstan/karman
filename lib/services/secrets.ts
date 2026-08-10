import 'server-only';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/lib/db/client';
import {
  authUser,
  passportIdentity,
  secretsProject,
  secretsItem,
  secretsToken,
  secretsAudit,
  secretsCard,
  secretsCardField,
  secretsGrant,
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
import { ACTOR_SYSTEM, actorOwner, actorPassport, actorToken } from '@/lib/secrets/actor';
import { resolveGrants, type GrantAlias } from '@/lib/secrets/grant';
import { parseCsv } from '@/lib/csv-parse';
import { mapCsvToCards } from '@/lib/secrets/csv-import';
import type {
  SecretProjectCreateInput,
  SecretProjectUpdateInput,
  SecretItemUpsertInput,
  SecretTokenCreateInput,
  SecretCardCreateInput,
  SecretCardUpdateInput,
  SecretCardFieldUpsertInput,
  SecretGrantCreateInput,
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
  /** Кто (ADR-0012 §6). null — строка старше миграции 0007, актор неизвестен. */
  actor: string | null;
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

/**
 * Строка аудита. `actor` — «кто», а не «что предъявили» (долг ADR-0012 §6):
 * владелец из GUI, паспортная сессия или статический токен комнаты. null —
 * актор неизвестен (так же читаются строки до миграции 0007).
 */
async function logAudit(
  projectId: number | null,
  tokenId: number | null,
  action: string,
  detail: string | null,
  ip: string | null,
  actor: string | null = null,
): Promise<void> {
  await db.insert(secretsAudit).values({ projectId, tokenId, action, detail, ip, actor });
}

// --- Проекты (UI владельца) -------------------------------------------------

export async function listProjects(user: SessionUser): Promise<SecretProjectListItem[]> {
  // Счётчики — grouped-подзапросами через LEFT JOIN, НЕ коррелированными
  // подзапросами: drizzle рендерит `${secretsProject.id}` внутри raw-`sql` в
  // select-проекции как безымянный `"id"`, который в подзапросе резолвится в
  // столбец дочерней таблицы (`where project_id = id`) и даёт неверный счёт.
  // Разные алиасы (`item_n`/`token_n`) — чтобы неквалифицированные имена в
  // проекции не конфликтовали (drizzle их тоже не квалифицирует).
  const itemCounts = db
    .select({ projectId: secretsItem.projectId, itemN: count().as('item_n') })
    .from(secretsItem)
    .groupBy(secretsItem.projectId)
    .as('item_counts');
  const tokenCounts = db
    .select({ projectId: secretsToken.projectId, tokenN: count().as('token_n') })
    .from(secretsToken)
    .where(isNull(secretsToken.revokedAt))
    .groupBy(secretsToken.projectId)
    .as('token_counts');

  const rows = await db
    .select({
      id: secretsProject.id,
      name: secretsProject.name,
      slug: secretsProject.slug,
      createdAt: secretsProject.createdAt,
      itemCount: itemCounts.itemN,
      tokenCount: tokenCounts.tokenN,
    })
    .from(secretsProject)
    .leftJoin(itemCounts, eq(itemCounts.projectId, secretsProject.id))
    .leftJoin(tokenCounts, eq(tokenCounts.projectId, secretsProject.id))
    .where(ownership(user, secretsProject.userId))
    .orderBy(desc(secretsProject.id));

  // LEFT JOIN → комнаты без секретов/токенов дают NULL; наружу — 0.
  return rows.map((r) => ({ ...r, itemCount: r.itemCount ?? 0, tokenCount: r.tokenCount ?? 0 }));
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
      actor: secretsAudit.actor,
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
  const value = decryptSecret(item, secretAad(item.projectId, item.key));
  // Раскрытие секрета владельцем — операция того же веса, что машинный pull,
  // и до ADR-0012 §6 она не оставляла в аудите ни строки.
  await logAudit(item.projectId, null, 'reveal', `key=${item.key}`, null, actorOwner(user.id));
  return value;
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
  const value = decryptSecret(field, cardFieldAad(field.cardId, field.name));
  const [card] = await db
    .select({ projectId: secretsCard.projectId })
    .from(secretsCard)
    .where(eq(secretsCard.id, field.cardId))
    .limit(1);
  await logAudit(
    card?.projectId ?? null,
    null,
    'reveal_card_field',
    `card=${field.cardId} field=${field.name}`,
    null,
    actorOwner(user.id),
  );
  return value;
}

/**
 * Импорт карточек из CSV (vault Ф3). Парсит, мапит колонки (браузерные
 * экспорты), создаёт карточки + поля с шифрованием. Каждая карточка — своя
 * транзакция (одна битая строка не откатывает весь импорт). null — нет доступа.
 */
export async function importCards(
  user: SessionUser,
  projectId: number,
  csvText: string,
): Promise<{ imported: number; skipped: number } | null> {
  if ((await ownedProjectId(user, projectId)) === null) return null;
  const { cards, skipped } = mapCsvToCards(parseCsv(csvText));

  let imported = 0;
  for (const card of cards) {
    await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(secretsCard)
        .values({ projectId, envKey: null, titleCt: '', titleIv: '', titleTag: '' })
        .returning({ id: secretsCard.id });
      const id = created!.id;
      const t = encryptSecret(card.title, cardTitleAad(id));
      await tx
        .update(secretsCard)
        .set({ titleCt: t.ciphertext, titleIv: t.iv, titleTag: t.authTag })
        .where(eq(secretsCard.id, id));
      if (card.fields.length > 0) {
        await tx.insert(secretsCardField).values(
          card.fields.map((f, idx) => {
            const enc = encryptSecret(f.value, cardFieldAad(id, f.name));
            return {
              cardId: id,
              name: f.name,
              kind: f.kind,
              ciphertext: enc.ciphertext,
              iv: enc.iv,
              authTag: enc.authTag,
              position: idx + 1,
            };
          }),
        );
      }
    });
    imported += 1;
  }
  return { imported, skipped };
}

// --- Токены доступа ---------------------------------------------------------

/** Создаёт токен; возвращает сам токен ОДИН раз (в БД только хэш). null — нет доступа. */
export async function createToken(
  user: SessionUser,
  input: SecretTokenCreateInput,
): Promise<string | null> {
  if ((await ownedProjectId(user, input.projectId)) === null) return null;
  const t = generateToken();
  const [created] = await db
    .insert(secretsToken)
    .values({
      projectId: input.projectId,
      name: input.name,
      tokenPrefix: t.prefix,
      tokenHash: t.hash,
      canWrite: input.canWrite,
    })
    .returning({ id: secretsToken.id });
  // Выпуск токена владельцем — вторая GUI-операция из долга ADR-0012 §6.
  await logAudit(
    input.projectId,
    created?.id ?? null,
    'token_created',
    `${input.canWrite ? 'rw' : 'ro'}-токен «${input.name}» (${t.prefix})`,
    null,
    actorOwner(user.id),
  );
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
  await logAudit(tok.projectId, tokenId, 'token_revoked', null, null, actorOwner(user.id));
  return true;
}

// --- Выдача доступа между комнатами (grant, мандат brain 2026-07-26) ---------

export type SecretGrantIssued = {
  id: number;
  sourceKey: string;
  targetProjectId: number;
  targetSlug: string;
  aliasKey: string;
  note: string | null;
  /** Есть ли в комнате-источнике ключ с таким именем (grant можно выдать заранее). */
  sourceExists: boolean;
  createdAt: string;
  revokedAt: string | null;
};
export type SecretGrantReceived = {
  id: number;
  aliasKey: string;
  sourceProjectId: number;
  sourceSlug: string;
  sourceKey: string;
  note: string | null;
  /** Заслонён ли grant собственным ключом комнаты (свой всегда выигрывает). */
  shadowed: boolean;
  createdAt: string;
  revokedAt: string | null;
};
export type SecretGrants = { issued: SecretGrantIssued[]; received: SecretGrantReceived[] };

/** Выдачи комнаты: кому она дала доступ и что получает сама. null — нет доступа. */
export async function listGrants(user: SessionUser, projectId: number): Promise<SecretGrants | null> {
  if ((await ownedProjectId(user, projectId)) === null) return null;

  const targetProject = alias(secretsProject, 'target_project');
  const issuedRows = await db
    .select({
      id: secretsGrant.id,
      sourceKey: secretsGrant.sourceKey,
      targetProjectId: secretsGrant.targetProjectId,
      targetSlug: targetProject.slug,
      aliasKey: secretsGrant.aliasKey,
      note: secretsGrant.note,
      sourceItemId: secretsItem.id,
      createdAt: secretsGrant.createdAt,
      revokedAt: secretsGrant.revokedAt,
    })
    .from(secretsGrant)
    .innerJoin(targetProject, eq(targetProject.id, secretsGrant.targetProjectId))
    .leftJoin(
      secretsItem,
      and(eq(secretsItem.projectId, secretsGrant.sourceProjectId), eq(secretsItem.key, secretsGrant.sourceKey)),
    )
    .where(eq(secretsGrant.sourceProjectId, projectId))
    .orderBy(desc(secretsGrant.id));

  const sourceProject = alias(secretsProject, 'source_project');
  const receivedRows = await db
    .select({
      id: secretsGrant.id,
      aliasKey: secretsGrant.aliasKey,
      sourceProjectId: secretsGrant.sourceProjectId,
      sourceSlug: sourceProject.slug,
      sourceKey: secretsGrant.sourceKey,
      note: secretsGrant.note,
      createdAt: secretsGrant.createdAt,
      revokedAt: secretsGrant.revokedAt,
    })
    .from(secretsGrant)
    .innerJoin(sourceProject, eq(sourceProject.id, secretsGrant.sourceProjectId))
    .where(eq(secretsGrant.targetProjectId, projectId))
    .orderBy(desc(secretsGrant.id));

  // Собственные ключи комнаты — чтобы показать заслонённые выдачи (свой выигрывает).
  const ownKeys = new Set(
    (
      await db.select({ key: secretsItem.key }).from(secretsItem).where(eq(secretsItem.projectId, projectId))
    ).map((r) => r.key),
  );

  return {
    issued: issuedRows.map(({ sourceItemId, ...r }) => ({ ...r, sourceExists: sourceItemId !== null })),
    received: receivedRows.map((r) => ({ ...r, shadowed: ownKeys.has(r.aliasKey) })),
  };
}

export type GrantCreateResult = { ok: true; id: number } | { ok: false; error: string };

/**
 * Выдаёт комнате-получателю доступ к одному ключу комнаты-источника. Значение НЕ
 * копируется и не расшифровывается здесь — получатель читает исходную запись своим
 * токеном под именем aliasKey. Полномочие — у владельца комнаты-ИСТОЧНИКА.
 * Обе операции (выдача у источника, получение у адресата) пишутся в аудит.
 */
export async function createGrant(
  user: SessionUser,
  input: SecretGrantCreateInput,
): Promise<GrantCreateResult> {
  const [source] = await db
    .select({ id: secretsProject.id, slug: secretsProject.slug })
    .from(secretsProject)
    .where(and(eq(secretsProject.id, input.sourceProjectId), ownership(user, secretsProject.userId)))
    .limit(1);
  if (!source) return { ok: false, error: 'Комната-источник не найдена' };

  const [target] = await db
    .select({ id: secretsProject.id, slug: secretsProject.slug })
    .from(secretsProject)
    .where(eq(secretsProject.id, input.targetProjectId))
    .limit(1);
  if (!target) return { ok: false, error: 'Комната-получатель не найдена' };

  const aliasKey = input.aliasKey ?? input.sourceKey;

  // Собственный ключ получателя всегда выигрывает — не даём завести заведомо
  // мёртвую выдачу (иначе «выдал, а значение не приходит» без объяснения).
  const [ownItem] = await db
    .select({ id: secretsItem.id })
    .from(secretsItem)
    .where(and(eq(secretsItem.projectId, target.id), eq(secretsItem.key, aliasKey)))
    .limit(1);
  if (ownItem) {
    return {
      ok: false,
      error: `У комнаты «${target.slug}» есть собственный ключ ${aliasKey} — он выигрывает у выданного доступа. Выберите другое имя или удалите свой ключ.`,
    };
  }

  const [dup] = await db
    .select({ id: secretsGrant.id })
    .from(secretsGrant)
    .where(
      and(
        eq(secretsGrant.targetProjectId, target.id),
        eq(secretsGrant.aliasKey, aliasKey),
        isNull(secretsGrant.revokedAt),
      ),
    )
    .limit(1);
  if (dup) {
    return { ok: false, error: `Комнате «${target.slug}» уже выдан доступ под именем ${aliasKey}` };
  }

  const [created] = await db
    .insert(secretsGrant)
    .values({
      sourceProjectId: source.id,
      sourceKey: input.sourceKey,
      targetProjectId: target.id,
      aliasKey,
      note: input.note ?? null,
    })
    .returning({ id: secretsGrant.id });
  const id = created!.id;

  const initiator = input.note ? `; инициатор: ${input.note}` : '';
  await logAudit(
    source.id,
    null,
    'grant_out',
    `выдан доступ к ${input.sourceKey} → комната «${target.slug}» как ${aliasKey}${initiator}`,
    null,
    actorOwner(user.id),
  );
  await logAudit(
    target.id,
    null,
    'grant_in',
    `получен доступ к ${aliasKey} ← комната «${source.slug}» (ключ ${input.sourceKey})${initiator}`,
    null,
    actorOwner(user.id),
  );
  return { ok: true, id };
}

/** Отзывает выдачу. Полномочие — у владельца комнаты-источника. */
export async function revokeGrant(user: SessionUser, grantId: number): Promise<boolean> {
  const [row] = await db
    .select({
      id: secretsGrant.id,
      sourceProjectId: secretsGrant.sourceProjectId,
      sourceKey: secretsGrant.sourceKey,
      targetProjectId: secretsGrant.targetProjectId,
      aliasKey: secretsGrant.aliasKey,
      revokedAt: secretsGrant.revokedAt,
    })
    .from(secretsGrant)
    .where(eq(secretsGrant.id, grantId))
    .limit(1);
  if (!row || row.revokedAt) return false;
  if ((await ownedProjectId(user, row.sourceProjectId)) === null) return false;

  const [source] = await db
    .select({ slug: secretsProject.slug })
    .from(secretsProject)
    .where(eq(secretsProject.id, row.sourceProjectId))
    .limit(1);
  const [target] = await db
    .select({ slug: secretsProject.slug })
    .from(secretsProject)
    .where(eq(secretsProject.id, row.targetProjectId))
    .limit(1);

  await db.update(secretsGrant).set({ revokedAt: isoNow() }).where(eq(secretsGrant.id, row.id));
  await logAudit(
    row.sourceProjectId,
    null,
    'grant_revoked',
    `отозван доступ к ${row.sourceKey} у комнаты «${target?.slug ?? row.targetProjectId}»`,
    null,
    actorOwner(user.id),
  );
  await logAudit(
    row.targetProjectId,
    null,
    'grant_revoked',
    `отозван доступ к ${row.aliasKey} (комната «${source?.slug ?? row.sourceProjectId}»)`,
    null,
    actorOwner(user.id),
  );
  return true;
}

/**
 * Пишет чтение по выданному доступу в аудит комнаты-ИСТОЧНИКА: у получателя оно
 * уже видно как обычный pull, а источник иначе не увидел бы, что его ключ читают
 * (требование мандата — обе стороны видят операцию).
 */
async function logGrantReads(
  targetProjectId: number,
  delivered: GrantAlias[],
  ip: string | null,
  actor: string | null = null,
): Promise<void> {
  if (delivered.length === 0) return;
  const [target] = await db
    .select({ slug: secretsProject.slug })
    .from(secretsProject)
    .where(eq(secretsProject.id, targetProjectId))
    .limit(1);
  const who = target?.slug ?? String(targetProjectId);
  for (const g of delivered) {
    await logAudit(
      g.sourceProjectId,
      null,
      'grant_read',
      `комната «${who}» прочитала ${g.sourceKey} по выданному доступу`,
      ip,
      actor,
    );
  }
}

/** Действующие выдачи, по которым комната-получатель читает чужие ключи. */
async function activeGrantsFor(targetProjectId: number): Promise<GrantAlias[]> {
  return db
    .select({
      id: secretsGrant.id,
      sourceProjectId: secretsGrant.sourceProjectId,
      sourceKey: secretsGrant.sourceKey,
      aliasKey: secretsGrant.aliasKey,
    })
    .from(secretsGrant)
    .where(and(eq(secretsGrant.targetProjectId, targetProjectId), isNull(secretsGrant.revokedAt)));
}

// --- Self-serve provisioning (API, без сессии) -------------------------------

export type ProvisionResult =
  | { ok: true; projectId: number; slug: string; token: string; tokenPrefix: string }
  | { ok: false; status: 409 | 500; error: string };

/** Аудит отказа по provisioning-ключу (неверный/отсутствующий Bearer). */
export async function logProvisionAuthDenied(ip: string | null): Promise<void> {
  await logAudit(null, null, 'provision_denied', 'недействительный provisioning-ключ', ip, ACTOR_SYSTEM);
}

/**
 * Заводит комнату проекта + read-write токен без владельца-MFA (self-serve
 * onboarding, мандат brain 2026-07-12). Гейт по `VAULT_PROVISION_KEY` — в роуте;
 * здесь инварианты: комната вешается на владельца-superuser, slug уникален,
 * токены к чужим ЖИВЫМ комнатам этим путём не минтятся, комната и токен
 * создаются атомарно, операция — в аудит-лог.
 *
 * Существующий slug (ADR-0010, мандат brain 2026-07-28): если комната пуста
 * (0 секретов, 0 карточек) и ни один её токен ни разу не использовался —
 * старые (потерянные при доставке) токены отзываются и выпускается свежий
 * rw-токен (аудит `provision_first_token`). Читать в такой комнате нечего,
 * а неиспользованный токен означает, что до легитимного держателя он не доехал.
 * Любой след жизни (секрет, карточка, использованный токен) → прежний 409,
 * переоткрытие только владельцем под 2FA.
 */
export async function provisionRoom(
  slug: string,
  name: string | undefined,
  ip: string | null,
): Promise<ProvisionResult> {
  const [owner] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(and(eq(authUser.isSuperuser, true), eq(authUser.isActive, true)))
    .orderBy(authUser.id)
    .limit(1);
  if (!owner) {
    await logAudit(null, null, 'provision_error', 'нет активного superuser-владельца', ip, ACTOR_SYSTEM);
    return { ok: false, status: 500, error: 'Сервис секретов недоступен' };
  }

  const [existing] = await db
    .select({ id: secretsProject.id })
    .from(secretsProject)
    .where(eq(secretsProject.slug, slug))
    .limit(1);
  if (existing) {
    return provisionFirstToken(existing.id, slug, ip);
  }

  const t = generateToken();
  const projectId = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(secretsProject)
      .values({ userId: owner.id, name: name ?? slug, slug })
      .returning({ id: secretsProject.id });
    const id = created!.id;
    await tx.insert(secretsToken).values({
      projectId: id,
      name: 'self-serve rw',
      tokenPrefix: t.prefix,
      tokenHash: t.hash,
      canWrite: true,
    });
    return id;
  });
  await logAudit(projectId, null, 'provision', `комната «${slug}» + rw-токен (self-serve)`, ip, ACTOR_SYSTEM);
  return { ok: true, projectId, slug, token: t.token, tokenPrefix: t.prefix };
}

/**
 * Первый рабочий токен для существующей, но нетронутой комнаты (ADR-0010).
 * Условия проверяет сервер: 0 секретов, 0 карточек, ни одного использования
 * токена. Ранее выданные (потерянные) токены отзываются в той же транзакции.
 */
async function provisionFirstToken(
  projectId: number,
  slug: string,
  ip: string | null,
): Promise<ProvisionResult> {
  const [items] = await db
    .select({ n: count() })
    .from(secretsItem)
    .where(eq(secretsItem.projectId, projectId));
  const [cards] = await db
    .select({ n: count() })
    .from(secretsCard)
    .where(eq(secretsCard.projectId, projectId));
  const [usedTokens] = await db
    .select({ n: count() })
    .from(secretsToken)
    .where(and(eq(secretsToken.projectId, projectId), sql`${secretsToken.lastUsedAt} is not null`));
  if ((items?.n ?? 1) > 0 || (cards?.n ?? 1) > 0 || (usedTokens?.n ?? 1) > 0) {
    await logAudit(
      projectId,
      null,
      'provision_denied',
      `комната «${slug}» уже живая (секреты/карточки/использованный токен) — переоткрытие только владельцем`,
      ip,
      ACTOR_SYSTEM,
    );
    return { ok: false, status: 409, error: 'Комната с таким slug уже существует' };
  }

  const t = generateToken();
  await db.transaction(async (tx) => {
    await tx
      .update(secretsToken)
      .set({ revokedAt: isoNow() })
      .where(and(eq(secretsToken.projectId, projectId), isNull(secretsToken.revokedAt)));
    await tx.insert(secretsToken).values({
      projectId,
      name: 'self-serve rw (first token)',
      tokenPrefix: t.prefix,
      tokenHash: t.hash,
      canWrite: true,
    });
  });
  await logAudit(
    projectId,
    null,
    'provision_first_token',
    `первый рабочий rw-токен комнаты «${slug}» (пустая, токены не использовались; старые отозваны)`,
    ip,
    ACTOR_SYSTEM,
  );
  return { ok: true, projectId, slug, token: t.token, tokenPrefix: t.prefix };
}

// --- Машинный доступ по токену (API, без сессии) ----------------------------

type ResolvedToken = {
  id: number;
  projectId: number;
  canWrite: boolean;
  tokenPrefix: string;
  /** Метка личности, если это паспортная сессия; null у статических токенов владельца. */
  identityLabel: string | null;
};
type TokenResolution =
  | { ok: true; token: ResolvedToken; actor: string }
  | { ok: false; projectId: number | null; tokenId: number | null; reason: string };

/**
 * Разбирает Bearer-токен машинного доступа. Кроме отзыва самого токена
 * проверяет две вещи, появившиеся с паспортом (ADR-0012 волна 2):
 *   - СРОК паспортной сессии (`expires_at`);
 *   - отзыв ЛИЧНОСТИ, которой сессия выдана.
 * Второе — тот самый каскад отзыва: пока проверка идёт на каждом чтении,
 * забытый каскад не оставляет живых артефактов у отозванной личности.
 * Статические токены владельца (`identity_id`/`expires_at` = NULL) ведут себя
 * как прежде.
 */
async function resolveApiToken(rawToken: string): Promise<TokenResolution> {
  if (!looksLikeToken(rawToken)) {
    return { ok: false, projectId: null, tokenId: null, reason: 'некорректный формат токена' };
  }
  const [row] = await db
    .select({
      id: secretsToken.id,
      projectId: secretsToken.projectId,
      canWrite: secretsToken.canWrite,
      tokenPrefix: secretsToken.tokenPrefix,
      revokedAt: secretsToken.revokedAt,
      expiresAt: secretsToken.expiresAt,
      identityLabel: passportIdentity.label,
      identityRevokedAt: passportIdentity.revokedAt,
    })
    .from(secretsToken)
    .leftJoin(passportIdentity, eq(passportIdentity.id, secretsToken.identityId))
    .where(eq(secretsToken.tokenHash, hashToken(rawToken)))
    .limit(1);

  if (!row) return { ok: false, projectId: null, tokenId: null, reason: 'неизвестный токен' };
  const bad = (reason: string): TokenResolution => ({
    ok: false,
    projectId: row.projectId,
    tokenId: row.id,
    reason,
  });
  if (row.revokedAt) return bad('токен отозван');
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) {
    return bad('срок сессии истёк');
  }
  if (row.identityRevokedAt) return bad('личность отозвана');

  return {
    ok: true,
    token: {
      id: row.id,
      projectId: row.projectId,
      canWrite: row.canWrite,
      tokenPrefix: row.tokenPrefix,
      identityLabel: row.identityLabel,
    },
    actor: row.identityLabel ? actorPassport(row.identityLabel) : actorToken(row.tokenPrefix),
  };
}

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
  const resolved = await resolveApiToken(rawToken);
  if (!resolved.ok) {
    await logAudit(resolved.projectId, resolved.tokenId, 'pull_denied', resolved.reason, ip);
    return { ok: false, status: 401, error: 'Недействительный токен' };
  }
  const tok = resolved.token;
  const actor = resolved.actor;

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

    // Ключи, выданные другими комнатами (grant): значение не копировалось —
    // читаем исходную запись и расшифровываем с AAD источника. Собственный ключ
    // комнаты выигрывает у выдачи (resolveGrants), источник может ещё не
    // существовать — тогда выдача просто не даёт значения.
    const granted = await activeGrantsFor(tok.projectId);
    const delivered: GrantAlias[] = [];
    for (const g of resolveGrants(Object.keys(secrets), granted).applied) {
      const [src] = await db
        .select({ ciphertext: secretsItem.ciphertext, iv: secretsItem.iv, authTag: secretsItem.authTag })
        .from(secretsItem)
        .where(and(eq(secretsItem.projectId, g.sourceProjectId), eq(secretsItem.key, g.sourceKey)))
        .limit(1);
      if (!src) continue;
      secrets[g.aliasKey] = decryptSecret(src, secretAad(g.sourceProjectId, g.sourceKey));
      delivered.push(g);
    }

    await db.update(secretsToken).set({ lastUsedAt: isoNow() }).where(eq(secretsToken.id, tok.id));

    if (keyFilter !== undefined) {
      if (!(keyFilter in secrets)) {
        await logAudit(tok.projectId, tok.id, 'pull_miss', keyFilter, ip, actor);
        return { ok: false, status: 404, error: 'Ключ не найден' };
      }
      await logAudit(tok.projectId, tok.id, 'pull', `key=${keyFilter}`, ip, actor);
      await logGrantReads(
        tok.projectId,
        delivered.filter((g) => g.aliasKey === keyFilter),
        ip,
        actor,
      );
      return { ok: true, secrets: { [keyFilter]: secrets[keyFilter]! } };
    }

    await logAudit(
      tok.projectId,
      tok.id,
      'pull',
      delivered.length > 0
        ? `${rows.length} ключей + ${delivered.length} по выданному доступу`
        : `${rows.length} ключей`,
      ip,
      actor,
    );
    await logGrantReads(tok.projectId, delivered, ip, actor);
    return { ok: true, secrets };
  } catch {
    // Например, SECRETS_MASTER_KEY не задан/неверен — расшифровка невозможна.
    await logAudit(tok.projectId, tok.id, 'pull_error', 'ошибка расшифровки (мастер-ключ?)', ip, actor);
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
  const resolved = await resolveApiToken(rawToken);
  if (!resolved.ok) {
    await logAudit(resolved.projectId, resolved.tokenId, 'push_denied', resolved.reason, ip);
    return { ok: false, status: 401, error: 'Недействительный токен' };
  }
  const tok = resolved.token;
  const actor = resolved.actor;
  if (!tok.canWrite) {
    await logAudit(tok.projectId, tok.id, 'push_denied', 'токен только для чтения', ip, actor);
    return { ok: false, status: 403, error: 'Токен не имеет прав записи' };
  }

  const entries = Object.entries(secrets);

  // Имя, которое приходит по выданному доступу, нельзя занять своей записью:
  // собственный ключ выигрывает у выдачи, и запись молча отрезала бы комнату от
  // чужого значения. Перезаписать имя может только владелец через GUI.
  const borrowed = new Set((await activeGrantsFor(tok.projectId)).map((g) => g.aliasKey));
  const clash = entries.map(([key]) => key).filter((key) => borrowed.has(key));
  if (clash.length > 0) {
    await logAudit(
      tok.projectId,
      tok.id,
      'push_denied',
      `ключи по выданному доступу: ${clash.join(', ')}`,
      ip,
      actor,
    );
    return {
      ok: false,
      status: 403,
      error: `Ключи приходят по выданному доступу и не могут быть перезаписаны: ${clash.join(', ')}`,
    };
  }

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
    await logAudit(tok.projectId, tok.id, 'push', `${entries.length} ключей`, ip, actor);
    return { ok: true, written: entries.length };
  } catch {
    await logAudit(tok.projectId, tok.id, 'push_error', 'ошибка шифрования/записи (мастер-ключ?)', ip, actor);
    return { ok: false, status: 500, error: 'Сервис секретов недоступен' };
  }
}
