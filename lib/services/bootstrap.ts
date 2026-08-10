import 'server-only';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { secretsAudit, secretsBootstrap, secretsProject, secretsToken } from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import { actorOwner } from '@/lib/secrets/actor';
import {
  clampTtlMinutes,
  generateBootstrapCode,
  hashBootstrapCode,
  looksLikeBootstrapCode,
} from '@/lib/secrets/bootstrap-code';
import { generateToken } from '@/lib/secrets/token';
import type { SecretBootstrapCreateInput } from '@/lib/validation/secret';

/**
 * Времянка — одноразовый обмен «код → токен своей комнаты» (задача владельца
 * 2026-08-10). Закрывает разрыв, который до сих пор латали руками: комнату,
 * наполненную владельцем ДО онбординга, self-serve-путь уже не открывает
 * (гейт девственности ADR-0010), а пересылать долгоживущий токен в чат нельзя.
 *
 * Времянка живёт минуты, гасится в момент обмена и привязана к ОДНОЙ комнате,
 * поэтому её можно назвать вслух. Долгоживущий токен при этом не звучит нигде.
 *
 * Отличие от паспорта (ADR-0012): паспорт доказывает личность подписью и не
 * требует произнесённых секретов вовсе — он лучше и остаётся штатным путём для
 * CI. Времянка — для случаев, где OIDC неоткуда взять: рантайм на VPS, ручной
 * онбординг, восстановление после потери токена.
 */

const isoNow = () => new Date().toISOString();

async function logAudit(
  projectId: number | null,
  tokenId: number | null,
  action: string,
  detail: string | null,
  ip: string | null,
  actor: string | null,
): Promise<void> {
  await db.insert(secretsAudit).values({ projectId, tokenId, action, detail, ip, actor });
}

export type BootstrapIssued = {
  /** Показывается владельцу ОДИН раз — это и есть то, что можно продиктовать. */
  code: string;
  codePrefix: string;
  expiresAt: string;
  canWrite: boolean;
};

/** Времянка комнаты для UI: значение не хранится, показывается только состояние. */
export type BootstrapMeta = {
  id: number;
  codePrefix: string;
  canWrite: boolean;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /** Живая = не обменяна, не отозвана, не истекла. Считается на сервере. */
  active: boolean;
};

/**
 * Выпускает времянку. Полномочие — у владельца комнаты (гейт /secrets уже
 * требует второй фактор). Право будущего токена фиксируется здесь: получатель
 * не выбирает себе полномочия сам.
 */
export async function createBootstrap(
  user: SessionUser,
  input: SecretBootstrapCreateInput,
): Promise<BootstrapIssued | null> {
  const [project] = await db
    .select({ id: secretsProject.id, slug: secretsProject.slug })
    .from(secretsProject)
    .where(and(eq(secretsProject.id, input.projectId), ownership(user, secretsProject.userId)))
    .limit(1);
  if (!project) return null;

  const ttl = clampTtlMinutes(input.ttlMinutes);
  const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();
  const c = generateBootstrapCode();

  await db.insert(secretsBootstrap).values({
    projectId: project.id,
    codeHash: c.hash,
    codePrefix: c.prefix,
    canWrite: input.canWrite,
    expiresAt,
    note: input.note ?? null,
  });
  await logAudit(
    project.id,
    null,
    'bootstrap_created',
    `времянка ${c.prefix} на ${ttl} мин (${input.canWrite ? 'rw' : 'ro'})${input.note ? `; ${input.note}` : ''}`,
    null,
    actorOwner(user.id),
  );
  return { code: c.code, codePrefix: c.prefix, expiresAt, canWrite: input.canWrite };
}

/** Времянки комнаты (без значений) — чтобы владелец видел живые и погасшие. */
export async function listBootstraps(user: SessionUser, projectId: number): Promise<BootstrapMeta[] | null> {
  const [project] = await db
    .select({ id: secretsProject.id })
    .from(secretsProject)
    .where(and(eq(secretsProject.id, projectId), ownership(user, secretsProject.userId)))
    .limit(1);
  if (!project) return null;

  const rows = await db
    .select({
      id: secretsBootstrap.id,
      codePrefix: secretsBootstrap.codePrefix,
      canWrite: secretsBootstrap.canWrite,
      expiresAt: secretsBootstrap.expiresAt,
      usedAt: secretsBootstrap.usedAt,
      revokedAt: secretsBootstrap.revokedAt,
      createdAt: secretsBootstrap.createdAt,
    })
    .from(secretsBootstrap)
    .where(eq(secretsBootstrap.projectId, projectId))
    .orderBy(desc(secretsBootstrap.id));

  const now = Date.now();
  return rows.map((r) => ({
    ...r,
    active: !r.usedAt && !r.revokedAt && new Date(r.expiresAt).getTime() > now,
  }));
}

/** Гасит невостребованную времянку до срока (передумали, продиктовали не тому). */
export async function revokeBootstrap(user: SessionUser, id: number): Promise<boolean> {
  const [row] = await db
    .select({
      id: secretsBootstrap.id,
      projectId: secretsBootstrap.projectId,
      codePrefix: secretsBootstrap.codePrefix,
      usedAt: secretsBootstrap.usedAt,
      revokedAt: secretsBootstrap.revokedAt,
    })
    .from(secretsBootstrap)
    .innerJoin(secretsProject, eq(secretsProject.id, secretsBootstrap.projectId))
    .where(and(eq(secretsBootstrap.id, id), ownership(user, secretsProject.userId)))
    .limit(1);
  // Обменянную времянку гасить нечего: она уже мертва, и «отзыв» создал бы
  // впечатление, что отозван выданный по ней токен. Токен отзывается отдельно.
  if (!row || row.usedAt || row.revokedAt) return false;

  await db.update(secretsBootstrap).set({ revokedAt: isoNow() }).where(eq(secretsBootstrap.id, row.id));
  await logAudit(
    row.projectId,
    null,
    'bootstrap_revoked',
    `времянка ${row.codePrefix} погашена владельцем до обмена`,
    null,
    actorOwner(user.id),
  );
  return true;
}

export type ClaimResult =
  | { ok: true; token: string; tokenPrefix: string; slug: string; projectId: number; canWrite: boolean }
  | { ok: false; status: 401; error: string };

/**
 * Обмен времянки на токен комнаты. Всё в одной транзакции с условным UPDATE:
 * два одновременных обмена одним кодом дают ровно один токен, второй получает
 * отказ — гонка здесь не теоретическая, код звучит в чате и его могут вставить
 * дважды.
 *
 * Наружу все отказы одинаковы: неизвестный код, истёкший, отозванный и уже
 * обменянный неразличимы, иначе эндпоинт становится оракулом. Подробность —
 * в аудит.
 */
export async function claimBootstrap(rawCode: string, ip: string | null): Promise<ClaimResult> {
  const deny = async (projectId: number | null, reason: string): Promise<ClaimResult> => {
    await logAudit(projectId, null, 'claim_denied', reason, ip, null);
    return { ok: false, status: 401, error: 'Недействительный код' };
  };

  if (!looksLikeBootstrapCode(rawCode)) return deny(null, 'некорректный формат кода');

  const [row] = await db
    .select({
      id: secretsBootstrap.id,
      projectId: secretsBootstrap.projectId,
      codePrefix: secretsBootstrap.codePrefix,
      canWrite: secretsBootstrap.canWrite,
      expiresAt: secretsBootstrap.expiresAt,
      usedAt: secretsBootstrap.usedAt,
      revokedAt: secretsBootstrap.revokedAt,
      slug: secretsProject.slug,
    })
    .from(secretsBootstrap)
    .innerJoin(secretsProject, eq(secretsProject.id, secretsBootstrap.projectId))
    .where(eq(secretsBootstrap.codeHash, hashBootstrapCode(rawCode)))
    .limit(1);

  if (!row) return deny(null, 'неизвестный код');
  if (row.revokedAt) return deny(row.projectId, `времянка ${row.codePrefix} отозвана`);
  if (row.usedAt) {
    // Повторный обмен — либо двойная вставка, либо чужие руки. Разницу видно
    // только по IP, поэтому он тут особенно важен.
    return deny(row.projectId, `времянка ${row.codePrefix} уже обменяна ранее`);
  }
  if (new Date(row.expiresAt).getTime() <= Date.now()) {
    return deny(row.projectId, `времянка ${row.codePrefix} истекла`);
  }

  const t = generateToken();
  const claimed = await db.transaction(async (tx) => {
    // Гашение — условным UPDATE по тем же признакам: выигрывает ровно одна
    // транзакция, проигравшая не получает строк и не выпускает токен.
    const marked = await tx
      .update(secretsBootstrap)
      .set({ usedAt: isoNow(), usedIp: ip })
      .where(
        and(
          eq(secretsBootstrap.id, row.id),
          isNull(secretsBootstrap.usedAt),
          isNull(secretsBootstrap.revokedAt),
        ),
      )
      .returning({ id: secretsBootstrap.id });
    if (marked.length === 0) return null;

    const [created] = await tx
      .insert(secretsToken)
      .values({
        projectId: row.projectId,
        name: `bootstrap ${row.codePrefix}`,
        tokenPrefix: t.prefix,
        tokenHash: t.hash,
        canWrite: row.canWrite,
      })
      .returning({ id: secretsToken.id });
    const tokenId = created!.id;
    await tx
      .update(secretsBootstrap)
      .set({ issuedTokenId: tokenId })
      .where(eq(secretsBootstrap.id, row.id));
    return tokenId;
  });

  if (claimed === null) return deny(row.projectId, `времянка ${row.codePrefix}: одновременный обмен`);

  await logAudit(
    row.projectId,
    claimed,
    'claim',
    `по времянке ${row.codePrefix} выдан ${row.canWrite ? 'rw' : 'ro'}-токен ${t.prefix}`,
    ip,
    `bootstrap:${row.codePrefix}`,
  );
  return {
    ok: true,
    token: t.token,
    tokenPrefix: t.prefix,
    slug: row.slug,
    projectId: row.projectId,
    canWrite: row.canWrite,
  };
}
