import 'server-only';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/lib/db/client';
import { secretsGrantPolicy, secretsProject, secretsToken } from '@/lib/db/schema';
import { isUniqueViolation } from '@/lib/db/pg-error';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import { actorOwner, actorRoom } from '@/lib/secrets/actor';
import { isoNow, logAudit, ownedProjectId } from './internal';
import { resolveApiToken } from './token';

/**
 * Политики приёма выдач — зона `secrets.ts` (S2 дорожной
 * карты доступов, D-119).
 *
 * Комната-получатель объявляет allowlist ОДИН раз: «принимаю
 * ключ KEY от комнаты-источника как ALIAS»; дальше предложение
 * источника принимается автоматически (auto-accept — хук в
 * `proposeGrantByToken` главного модуля, здесь только политики).
 *
 * Два равноправных пути, ОДНО ядро (инварианты, вставки, аудит
 * идентичны — отличается только принципал):
 *   - машинный: токен САМОЙ комнаты-получателя с правом записи
 *     (`declarePolicyByToken`, `revokePolicyByToken`);
 *   - GUI владельца: сессия под гейтом 2FA (`createPolicy`,
 *     `revokePolicy`) — как у выдач, владелец полномочен над
 *     своей комнатой.
 *
 * Полномочие — у получателя: политика выражает ЕГО согласие
 * принимать чужие ключи (#272), поэтому объявляет и отзывает
 * только он, а не источник.
 */

export type SecretPolicyListItem = {
  id: number;
  sourceProjectId: number;
  sourceSlug: string;
  sourceKey: string;
  aliasKey: string;
  note: string | null;
  createdAt: string;
  revokedAt: string | null;
};

export type SecretPolicyDeclareInput = {
  /** Комната-источник — по slug (как в propose). */
  source_slug: string;
  source_key: string;
  /** Имя, под которым значение приезжает; по умолчанию = ключ источника. */
  alias?: string;
  note?: string;
};

/** GUI-путь владельца: комнаты по id (зеркало `secretGrantCreateSchema`). */
export type SecretPolicyCreateInput = {
  targetProjectId: number;
  sourceProjectId: number;
  sourceKey: string;
  aliasKey?: string;
  note?: string;
};

export type PolicyApiResult =
  | { ok: true; id: number; autoAccept: boolean }
  | { ok: false; status: 400 | 401 | 403 | 404 | 409; error: string };

export type PolicyOwnerResult = { ok: true; id: number } | { ok: false; error: string };

type RoomRef = { id: number; slug: string };

/** Список политик комнаты (живые и отозванные — обе в аудите). */
export async function listPolicies(targetProjectId: number): Promise<SecretPolicyListItem[]> {
  const sourceProject = alias(secretsProject, 'policy_source');
  const rows = await db
    .select({
      id: secretsGrantPolicy.id,
      sourceProjectId: secretsGrantPolicy.sourceProjectId,
      sourceSlug: sourceProject.slug,
      sourceKey: secretsGrantPolicy.sourceKey,
      aliasKey: secretsGrantPolicy.aliasKey,
      note: secretsGrantPolicy.note,
      createdAt: secretsGrantPolicy.createdAt,
      revokedAt: secretsGrantPolicy.revokedAt,
    })
    .from(secretsGrantPolicy)
    .innerJoin(sourceProject, eq(sourceProject.id, secretsGrantPolicy.sourceProjectId))
    .where(eq(secretsGrantPolicy.targetProjectId, targetProjectId))
    .orderBy(desc(secretsGrantPolicy.id));
  return rows;
}

/** Свои политики по токену комнаты (машинный GET; read-only токен подходит). */
export async function listPoliciesByToken(
  rawToken: string,
  ip: string | null,
): Promise<
  { ok: true; slug: string; policies: SecretPolicyListItem[] } | { ok: false; status: 401; error: string }
> {
  const resolved = await resolveApiToken(rawToken);
  if (!resolved.ok) {
    await logAudit(resolved.projectId, resolved.tokenId, 'policy_denied', resolved.reason, ip);
    return { ok: false, status: 401, error: 'Недействительный токен' };
  }
  const [room] = await db
    .select({ slug: secretsProject.slug })
    .from(secretsProject)
    .where(eq(secretsProject.id, resolved.token.projectId))
    .limit(1);
  if (!room) return { ok: false, status: 401, error: 'Недействительный токен' };
  return { ok: true, slug: room.slug, policies: await listPolicies(resolved.token.projectId) };
}

/** Свои политики комнаты под сессией владельца (GUI); null — нет доступа. */
export async function listPoliciesForUser(
  user: SessionUser,
  projectId: number,
): Promise<SecretPolicyListItem[] | null> {
  if ((await ownedProjectId(user, projectId)) === null) return null;
  return listPolicies(projectId);
}

/**
 * Живая политика приёма для тройки (получатель, источник, ключ).
 * null — политики нет или отозвана: предложение ждёт ручного accept.
 */
export async function matchGrantPolicy(
  targetProjectId: number,
  sourceProjectId: number,
  sourceKey: string,
): Promise<{ id: number; aliasKey: string } | null> {
  const [row] = await db
    .select({ id: secretsGrantPolicy.id, aliasKey: secretsGrantPolicy.aliasKey })
    .from(secretsGrantPolicy)
    .where(
      and(
        eq(secretsGrantPolicy.targetProjectId, targetProjectId),
        eq(secretsGrantPolicy.sourceProjectId, sourceProjectId),
        eq(secretsGrantPolicy.sourceKey, sourceKey),
        isNull(secretsGrantPolicy.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

type PolicyRoom = {
  tokenId: number;
  room: RoomRef;
  actor: string;
};

/**
 * Разбор токена для ОПЕРАЦИЙ с политиками: только токен с правом ЗАПИСИ —
 * политика есть согласие принимать чужие ключи, операция класса записи.
 * Отказы — в аудит.
 */
async function resolvePolicyRoom(
  rawToken: string,
  ip: string | null,
): Promise<PolicyRoom | { ok: false; status: 401 | 403; error: string }> {
  const resolved = await resolveApiToken(rawToken);
  if (!resolved.ok) {
    await logAudit(resolved.projectId, resolved.tokenId, 'policy_denied', resolved.reason, ip);
    return { ok: false, status: 401, error: 'Недействительный токен' };
  }
  const tok = resolved.token;
  if (!tok.canWrite) {
    await logAudit(tok.projectId, tok.id, 'policy_denied', 'токен только для чтения', ip, resolved.actor);
    return { ok: false, status: 403, error: 'Политику приёма может объявить только токен с правом записи' };
  }
  const [room] = await db
    .select({ id: secretsProject.id, slug: secretsProject.slug })
    .from(secretsProject)
    .where(eq(secretsProject.id, tok.projectId))
    .limit(1);
  if (!room) return { ok: false, status: 401, error: 'Недействительный токен' };

  return { tokenId: tok.id, room, actor: actorRoom(room.slug) };
}

/** Комната по slug. */
async function roomBySlug(slug: string): Promise<RoomRef | null> {
  const [row] = await db
    .select({ id: secretsProject.id, slug: secretsProject.slug })
    .from(secretsProject)
    .where(eq(secretsProject.slug, slug))
    .limit(1);
  return row ?? null;
}

/** Обновляет last_used токена (тот же принцип, что у выдач). */
async function touchToken(tokenId: number): Promise<void> {
  await db.update(secretsToken).set({ lastUsedAt: isoNow() }).where(eq(secretsToken.id, tokenId));
}

/**
 * Ядро объявления (общее для машинного и GUI-пути): вставка, дубль — 409
 * (частичный уникальный индекс 0023), аудит `policy_declared` у получателя.
 * Возвращает id политики или null — дубль живой политики.
 */
async function insertPolicyRow(
  target: RoomRef,
  source: RoomRef,
  sourceKey: string,
  aliasKey: string,
  note: string | null,
  ip: string | null,
  actor: string,
): Promise<number | null> {
  let id: number;
  try {
    const [created] = await db
      .insert(secretsGrantPolicy)
      .values({
        targetProjectId: target.id,
        sourceProjectId: source.id,
        sourceKey,
        aliasKey,
        note,
      })
      .returning({ id: secretsGrantPolicy.id });
    id = created!.id;
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
  await logAudit(
    target.id,
    null,
    'policy_declared',
    `принимаю ${sourceKey} от комнаты «${source.slug}» как ${aliasKey}; авто-приём включён${note ? `; основание: ${note}` : ''}`,
    ip,
    actor,
  );
  return id;
}

/**
 * Ядро отзыва (общее для машинного и GUI-пути): строка должна принадлежать
 * комнате-получателю `target` и быть живой; аудит `policy_revoked`.
 */
async function revokePolicyRow(
  target: RoomRef,
  policyId: number,
  ip: string | null,
  actor: string,
): Promise<{ ok: true; id: number } | { ok: false; status: 404 | 409; error: string }> {
  const [policy] = await db
    .select({
      id: secretsGrantPolicy.id,
      sourceKey: secretsGrantPolicy.sourceKey,
      sourceProjectId: secretsGrantPolicy.sourceProjectId,
      revokedAt: secretsGrantPolicy.revokedAt,
    })
    .from(secretsGrantPolicy)
    .where(and(eq(secretsGrantPolicy.id, policyId), eq(secretsGrantPolicy.targetProjectId, target.id)))
    .limit(1);
  if (!policy) return { ok: false, status: 404, error: 'Политика приёма не найдена' };
  if (policy.revokedAt) return { ok: false, status: 409, error: 'Политика приёма уже отозвана' };

  const updated = await db
    .update(secretsGrantPolicy)
    .set({ revokedAt: isoNow() })
    .where(and(eq(secretsGrantPolicy.id, policy.id), isNull(secretsGrantPolicy.revokedAt)))
    .returning({ id: secretsGrantPolicy.id });
  if (updated.length === 0) return { ok: false, status: 409, error: 'Политика приёма уже отозвана' };

  const [source] = await db
    .select({ slug: secretsProject.slug })
    .from(secretsProject)
    .where(eq(secretsProject.id, policy.sourceProjectId))
    .limit(1);
  await logAudit(
    target.id,
    null,
    'policy_revoked',
    `отозвана политика приёма «${policy.sourceKey} от комнаты «${source?.slug ?? policy.sourceProjectId}»; авто-приём выключен, предложения ждут ручного accept`,
    ip,
    actor,
  );
  return { ok: true, id: policy.id };
}

/**
 * Машинный путь: объявляет политику приёма токеном САМОЙ комнаты-получателя.
 *
 * Инварианты:
 *   - источник ≠ получатель (себе выдавать нечего — 409);
 *   - одна живая политика на (получатель, источник, ключ) — дубль 409;
 *   - авто-приём включается сразу: следующее предложение по тройке
 *     принимается автоматически; имя приёма фиксирует политика.
 */
export async function declarePolicyByToken(
  rawToken: string,
  ip: string | null,
  input: SecretPolicyDeclareInput,
): Promise<PolicyApiResult> {
  const r = await resolvePolicyRoom(rawToken, ip);
  if ('ok' in r) return r; // отказ: неисправный/read-only токен

  const source = await roomBySlug(input.source_slug);
  if (!source) return { ok: false, status: 404, error: 'Комната-источник не найдена' };
  if (source.id === r.room.id) {
    return { ok: false, status: 409, error: 'Комната-источник и комната-получатель совпадают' };
  }

  const aliasKey = input.alias?.trim() || input.source_key;
  const id = await insertPolicyRow(r.room, source, input.source_key, aliasKey, input.note ?? null, ip, r.actor);
  if (id === null) {
    return {
      ok: false,
      status: 409,
      error: `Политика приёма «${input.source_key} от ${input.source_slug}» уже объявлена`,
    };
  }
  await touchToken(r.tokenId);
  return { ok: true, id, autoAccept: true };
}

/**
 * Машинный путь: отзывает политику токеном комнаты-получателя — одной
 * строкой, вступает сразу: будущие предложения ждут ручного accept,
 * уже принятые выдачи остаются (согласие дано в момент приёма).
 */
export async function revokePolicyByToken(
  rawToken: string,
  ip: string | null,
  policyId: number,
): Promise<{ ok: true; id: number } | { ok: false; status: 401 | 403 | 404 | 409; error: string }> {
  const r = await resolvePolicyRoom(rawToken, ip);
  if ('ok' in r) return r;
  const result = await revokePolicyRow(r.room, policyId, ip, r.actor);
  if (!result.ok) return result;
  await touchToken(r.tokenId);
  return result;
}

/**
 * GUI-путь владельца: объявляет политику приёма своей комнате (зеркало
 * `createGrant` у выдач: владелец полномочен над своей комнатой; источник —
 * любая комната по id). Принципал в аудите — `owner:<id>`.
 */
export async function createPolicy(
  user: SessionUser,
  input: SecretPolicyCreateInput,
): Promise<PolicyOwnerResult> {
  const [target] = await db
    .select({ id: secretsProject.id, slug: secretsProject.slug })
    .from(secretsProject)
    .where(and(eq(secretsProject.id, input.targetProjectId), ownership(user, secretsProject.userId)))
    .limit(1);
  if (!target) return { ok: false, error: 'Комната-получатель не найдена' };

  const [source] = await db
    .select({ id: secretsProject.id, slug: secretsProject.slug })
    .from(secretsProject)
    .where(eq(secretsProject.id, input.sourceProjectId))
    .limit(1);
  if (!source) return { ok: false, error: 'Комната-источник не найдена' };
  if (source.id === target.id) {
    return { ok: false, error: 'Комната-источник и комната-получатель совпадают' };
  }

  const aliasKey = input.aliasKey?.trim() || input.sourceKey;
  const id = await insertPolicyRow(
    target,
    source,
    input.sourceKey,
    aliasKey,
    input.note ?? null,
    null,
    actorOwner(user.id),
  );
  if (id === null) {
    return {
      ok: false,
      error: `Политика приёма «${input.sourceKey} от комнаты «${source.slug}» уже объявлена`,
    };
  }
  return { ok: true, id };
}

/** GUI-путь владельца: отзывает политику своей комнаты. false — не найдена. */
export async function revokePolicy(user: SessionUser, policyId: number): Promise<boolean> {
  // Цель — комната политики: строка без гейта не видна наружу, но владение
  // проверяется на её комнате-получателе, как у выдач (чужая — 404/false).
  const [policy] = await db
    .select({ targetProjectId: secretsGrantPolicy.targetProjectId })
    .from(secretsGrantPolicy)
    .where(eq(secretsGrantPolicy.id, policyId))
    .limit(1);
  if (!policy) return false;
  const [target] = await db
    .select({ id: secretsProject.id, slug: secretsProject.slug })
    .from(secretsProject)
    .where(and(eq(secretsProject.id, policy.targetProjectId), ownership(user, secretsProject.userId)))
    .limit(1);
  if (!target) return false;
  const result = await revokePolicyRow(target, policyId, null, actorOwner(user.id));
  return result.ok;
}

/** Число живых политик комнаты (для диагностики/инвентаря). */
export async function countLivePolicies(targetProjectId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(secretsGrantPolicy)
    .where(
      and(
        eq(secretsGrantPolicy.targetProjectId, targetProjectId),
        isNull(secretsGrantPolicy.revokedAt),
      ),
    );
  return row?.n ?? 0;
}
