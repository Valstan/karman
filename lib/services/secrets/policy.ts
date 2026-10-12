import 'server-only';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/lib/db/client';
import { secretsGrantPolicy, secretsProject, secretsToken } from '@/lib/db/schema';
import { isUniqueViolation } from '@/lib/db/pg-error';
import { actorRoom } from '@/lib/secrets/actor';
import { isoNow, logAudit } from './internal';
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
 * Полномочие — у пишущего токена САМОЙ комнаты-получателя:
 * политика выражает согласие получателя (#272), поэтому
 * объявлять и отзывать может только он, а не источник.
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

export type PolicyApiResult =
  | { ok: true; id: number; autoAccept: boolean }
  | { ok: false; status: 400 | 401 | 403 | 404 | 409; error: string };

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
  tokenPrefix: string;
  room: { id: number; slug: string };
  actor: string;
  presented: string;
};

/**
 * Разбор токена для операций с политиками. Право объявлять
 * политику — у токена с правом ЗАПИСИ: политика — выражение
 * согласия комнаты принимать чужие ключи, операция класса записи.
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

  const presented = tok.identityLabel ? `паспорт ${tok.identityLabel}` : `токен ${tok.tokenPrefix}`;
  return { tokenId: tok.id, tokenPrefix: tok.tokenPrefix, room, actor: actorRoom(room.slug), presented };
}

/** Комната-источник по slug. */
async function roomBySlug(slug: string): Promise<{ id: number; slug: string } | null> {
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
 * Объявляет политику приёма: «принимаю source_key от source_slug
 * как alias». Комната объявляет СВОЮ политику своим пишущим
 * токеном — согласие даёт получатель, не источник (#272).
 *
 * Инварианты:
 *   - источник ≠ получатель (себе выдавать нечего — 409);
 *   - одна живая политика на (получатель, источник, ключ) — дубль 409
 *     (частичный уникальный индекс 0023);
 *   - авто-приём включается сразу: следующее предложение по этой
 *     тройке принимается автоматически.
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
  let id: number;
  try {
    const [created] = await db
      .insert(secretsGrantPolicy)
      .values({
        targetProjectId: r.room.id,
        sourceProjectId: source.id,
        sourceKey: input.source_key,
        aliasKey,
        note: input.note ?? null,
      })
      .returning({ id: secretsGrantPolicy.id });
    id = created!.id;
  } catch (e) {
    // Дубль живой политики (частичный уникальный индекс 0023).
    if (isUniqueViolation(e)) {
      return {
        ok: false,
        status: 409,
        error: `Политика приёма «${input.source_key} от ${input.source_slug}» уже объявлена`,
      };
    }
    throw e;
  }

  await logAudit(
    r.room.id,
    null,
    'policy_declared',
    `принимаю ${input.source_key} от комнаты «${source.slug}» как ${aliasKey}; авто-приём включён${input.note ? `; основание: ${input.note}` : ''}`,
    ip,
    r.actor,
  );
  await touchToken(r.tokenId);
  return { ok: true, id, autoAccept: true };
}

/**
 * Отзывает политику приёма — одной строкой, вступает сразу:
 * будущие предложения ждут ручного accept. Уже принятые выдачи
 * остаются (согласие на них было дано в момент приёма).
 */
export async function revokePolicyByToken(
  rawToken: string,
  ip: string | null,
  policyId: number,
): Promise<{ ok: true; id: number } | { ok: false; status: 401 | 403 | 404 | 409; error: string }> {
  const r = await resolvePolicyRoom(rawToken, ip);
  if ('ok' in r) return r;

  const [policy] = await db
    .select({
      id: secretsGrantPolicy.id,
      sourceKey: secretsGrantPolicy.sourceKey,
      sourceProjectId: secretsGrantPolicy.sourceProjectId,
      revokedAt: secretsGrantPolicy.revokedAt,
    })
    .from(secretsGrantPolicy)
    .where(and(eq(secretsGrantPolicy.id, policyId), eq(secretsGrantPolicy.targetProjectId, r.room.id)))
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
    r.room.id,
    null,
    'policy_revoked',
    `отозвана политика приёма «${policy.sourceKey} от комнаты «${source?.slug ?? policy.sourceProjectId}»; авто-приём выключен, предложения ждут ручного accept`,
    ip,
    r.actor,
  );
  await touchToken(r.tokenId);
  return { ok: true, id: policy.id };
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
