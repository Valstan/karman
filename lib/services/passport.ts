import 'server-only';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { db } from '@/lib/db/client';
import {
  passportAssertion,
  passportIdentity,
  passportIssuer,
  secretsAudit,
  secretsProject,
  secretsToken,
} from '@/lib/db/schema';
import { getJwks } from '@/lib/passport/jwks';
import { verifyAssertion } from '@/lib/passport/verify';
import { actorPassport } from '@/lib/secrets/actor';
import { rateLimit } from '@/lib/secrets/rate-limit';
import { generateToken, hashToken, looksLikeToken } from '@/lib/secrets/token';

/**
 * Паспортный вход в vault (ADR-0012 мозга, волна 2): проект предъявляет
 * подписанное удостоверение своего CI и получает КОРОТКОЖИВУЩИЙ токен своей
 * комнаты. Общий `VAULT_PROVISION_KEY` перестаёт быть штатным входом.
 *
 * Что здесь, а не в верификаторе: одноразовость удостоверения, карта
 * личность→комната, рейт-лимит по ДОКАЗАННОМУ claim'у, выдача и отзыв сессии.
 * Проверка самой подписи — чистый `lib/passport/verify.ts`.
 *
 * Инварианты, заданные адверсариальной проверкой ADR-0012 §5:
 *   - неизвестная личность НЕ заводит комнату и не выводит slug из имени репо;
 *   - `jti` записывается ТОЛЬКО при успехе и в одной транзакции с выдачей
 *     токена (иначе ретрай CI ломается о собственный anti-replay);
 *   - отзыв личности гасит её живые сессии — и, сверх того, проверяется на
 *     каждом чтении (`lib/services/secrets.ts`), а не только в момент отзыва.
 */

const DEFAULT_TTL_MINUTES = 60;
const MIN_TTL_MINUTES = 5;
const MAX_TTL_MINUTES = 720;
/** Запросов сессии на личность в минуту — бакет по доказанному claim'у, не по IP. */
const RATE_LIMIT_PREFIX = 'passport';

function sessionTtlMinutes(): number {
  const raw = Number(process.env.PASSPORT_SESSION_TTL_MINUTES ?? DEFAULT_TTL_MINUTES);
  if (!Number.isFinite(raw)) return DEFAULT_TTL_MINUTES;
  return Math.min(MAX_TTL_MINUTES, Math.max(MIN_TTL_MINUTES, Math.trunc(raw)));
}

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

export type SessionOpened = {
  ok: true;
  token: string;
  tokenPrefix: string;
  expiresAt: string;
  projectId: number;
  slug: string;
  canWrite: boolean;
  /** Подпись проверена по устаревшему снимку JWKS (issuer был недоступен). */
  jwksStale: boolean;
};
export type SessionFailure = { ok: false; status: 401 | 403 | 429 | 503; error: string };
export type SessionResult = SessionOpened | SessionFailure;

/** `iss` из тела удостоверения — ТОЛЬКО чтобы выбрать строку реестра; доверие даёт подпись. */
function claimedIssuer(rawJwt: string): string | null {
  try {
    const iss = decodeJwt(rawJwt).iss;
    return typeof iss === 'string' && iss.length > 0 ? iss : null;
  } catch {
    return null;
  }
}

/**
 * Открывает сессию по удостоверению CI. Наружу причина отказа не раскрывается
 * (неизвестная личность и битая подпись для предъявителя неразличимы) —
 * подробность уходит в аудит.
 */
export async function openSession(rawJwt: string, ip: string | null): Promise<SessionResult> {
  const iss = claimedIssuer(rawJwt);
  if (!iss) {
    await logAudit(null, null, 'passport_denied', 'удостоверение не разбирается', ip, null);
    return { ok: false, status: 401, error: 'Недействительное удостоверение' };
  }

  const [issuer] = await db
    .select()
    .from(passportIssuer)
    .where(and(eq(passportIssuer.issuer, iss), eq(passportIssuer.enabled, true)))
    .limit(1);
  if (!issuer) {
    await logAudit(null, null, 'passport_denied', `issuer вне реестра: ${iss}`, ip, null);
    return { ok: false, status: 401, error: 'Недействительное удостоверение' };
  }

  const snapshot = await getJwks(issuer.jwksUri);
  if (!snapshot) {
    // Ключей нет вовсе (первый фетч не удался) — отказ, а не пропуск проверки.
    await logAudit(null, null, 'passport_error', `JWKS недоступен: ${issuer.jwksUri}`, ip, null);
    return { ok: false, status: 503, error: 'Проверка удостоверений временно недоступна' };
  }

  const verified = await verifyAssertion(rawJwt, issuer, snapshot.jwks);
  if (!verified.ok) {
    await logAudit(null, null, 'passport_denied', `${verified.reason}: ${verified.detail}`, ip, null);
    return { ok: false, status: 401, error: 'Недействительное удостоверение' };
  }
  const principal = verified.principal;

  // Рейт-лимит по ДОКАЗАННОМУ claim'у: бакет по заголовку, который клиент
  // подставляет сам (x-forwarded-for), был бы декорацией (ADR-0012 §5).
  if (!rateLimit(`${RATE_LIMIT_PREFIX}|${issuer.id}|${principal.identityValue}`)) {
    await logAudit(
      null,
      null,
      'passport_denied',
      `лимит запросов личности ${principal.identityValue}`,
      ip,
      null,
    );
    return { ok: false, status: 429, error: 'Слишком много запросов' };
  }

  const [identity] = await db
    .select({
      id: passportIdentity.id,
      label: passportIdentity.label,
      projectId: passportIdentity.projectId,
      canWrite: passportIdentity.canWrite,
      slug: secretsProject.slug,
    })
    .from(passportIdentity)
    .innerJoin(secretsProject, eq(secretsProject.id, passportIdentity.projectId))
    .where(
      and(
        eq(passportIdentity.issuerId, issuer.id),
        eq(passportIdentity.identityValue, principal.identityValue),
        isNull(passportIdentity.revokedAt),
      ),
    )
    .limit(1);
  if (!identity) {
    // Автозаведение комнаты неизвестной личности запрещено: вывод slug'а из
    // имени репо не инъективен, а в vault уже лежали мусорные комнаты.
    await logAudit(
      null,
      null,
      'passport_denied',
      `личность вне реестра: ${principal.identityValue} (${principal.subject})`,
      ip,
      null,
    );
    return { ok: false, status: 403, error: 'Личность не зарегистрирована' };
  }

  const t = generateToken();
  const expiresAt = new Date(Date.now() + sessionTtlMinutes() * 60_000).toISOString();

  // Одна транзакция: сгоревший jti без выданного токена — это сломанный ретрай
  // CI, выданный токен без записанного jti — это replay-окно.
  let tokenId: number;
  try {
    tokenId = await db.transaction(async (tx) => {
      const replay = await tx
        .insert(passportAssertion)
        .values({
          issuerId: issuer.id,
          jti: principal.jti,
          subject: principal.subject,
          expiresAt: new Date(principal.expiresAtMs).toISOString(),
        })
        .onConflictDoNothing({ target: [passportAssertion.issuerId, passportAssertion.jti] })
        .returning({ id: passportAssertion.id });
      if (replay.length === 0) throw new ReplayError();

      const [created] = await tx
        .insert(secretsToken)
        .values({
          projectId: identity.projectId,
          name: `passport ${identity.label}`.slice(0, 200),
          tokenPrefix: t.prefix,
          tokenHash: t.hash,
          canWrite: identity.canWrite,
          expiresAt,
          identityId: identity.id,
        })
        .returning({ id: secretsToken.id });
      return created!.id;
    });
  } catch (e) {
    if (e instanceof ReplayError) {
      await logAudit(
        identity.projectId,
        null,
        'passport_denied',
        `повторное предъявление удостоверения (jti ${principal.jti})`,
        ip,
        actorPassport(identity.label),
      );
      return { ok: false, status: 401, error: 'Недействительное удостоверение' };
    }
    throw e;
  }

  await logAudit(
    identity.projectId,
    tokenId,
    'session_open',
    `сессия по паспорту, TTL ${sessionTtlMinutes()} мин${snapshot.stale ? '; JWKS из устаревшего снимка' : ''}`,
    ip,
    actorPassport(identity.label),
  );
  await cleanupAssertions();

  return {
    ok: true,
    token: t.token,
    tokenPrefix: t.prefix,
    expiresAt,
    projectId: identity.projectId,
    slug: identity.slug,
    canWrite: identity.canWrite,
    jwksStale: snapshot.stale,
  };
}

/** Повтор удостоверения — отдельный класс, чтобы не спутать с ошибкой БД в транзакции. */
class ReplayError extends Error {}

/**
 * Записи anti-replay живут не дольше самих удостоверений: истёкшее удостоверение
 * не проходит проверку срока, и хранить его jti незачем. Сутки запаса — на
 * расхождение часов и на разбор инцидентов.
 */
async function cleanupAssertions(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
  await db.delete(passportAssertion).where(lt(passportAssertion.expiresAt, cutoff));
}

export type SessionInfo = {
  slug: string;
  projectId: number;
  canWrite: boolean;
  /** Паспортная сессия (метка личности) или статический токен комнаты (null). */
  identityLabel: string | null;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

/**
 * Интроспекция текущего токена — `GET /api/secrets/self`. Клиент CI должен уметь
 * ответить «кто я и до когда» без обращения к владельцу.
 */
export async function describeSession(rawToken: string): Promise<SessionInfo | null> {
  if (!looksLikeToken(rawToken)) return null;
  const [row] = await db
    .select({
      slug: secretsProject.slug,
      projectId: secretsToken.projectId,
      canWrite: secretsToken.canWrite,
      identityLabel: passportIdentity.label,
      identityRevokedAt: passportIdentity.revokedAt,
      expiresAt: secretsToken.expiresAt,
      createdAt: secretsToken.createdAt,
      lastUsedAt: secretsToken.lastUsedAt,
      revokedAt: secretsToken.revokedAt,
    })
    .from(secretsToken)
    .innerJoin(secretsProject, eq(secretsProject.id, secretsToken.projectId))
    .leftJoin(passportIdentity, eq(passportIdentity.id, secretsToken.identityId))
    .where(eq(secretsToken.tokenHash, hashToken(rawToken)))
    .limit(1);
  if (!row || row.revokedAt || row.identityRevokedAt) return null;
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return null;

  return {
    slug: row.slug,
    projectId: row.projectId,
    canWrite: row.canWrite,
    identityLabel: row.identityLabel,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

/**
 * Самоотзыв сессии — `DELETE /api/secrets/session`. Держатель токена обязан уметь
 * погасить его сам: иначе единственный путь отзыва — владелец, то есть тот самый
 * человек, которого паспорт убирает из штатного контура.
 */
export async function revokeSession(rawToken: string, ip: string | null): Promise<boolean> {
  if (!looksLikeToken(rawToken)) return false;
  const [row] = await db
    .select({
      id: secretsToken.id,
      projectId: secretsToken.projectId,
      revokedAt: secretsToken.revokedAt,
      identityLabel: passportIdentity.label,
    })
    .from(secretsToken)
    .leftJoin(passportIdentity, eq(passportIdentity.id, secretsToken.identityId))
    .where(eq(secretsToken.tokenHash, hashToken(rawToken)))
    .limit(1);
  if (!row || row.revokedAt) return false;

  await db.update(secretsToken).set({ revokedAt: isoNow() }).where(eq(secretsToken.id, row.id));
  await logAudit(
    row.projectId,
    row.id,
    'session_revoked',
    'самоотзыв держателем токена',
    ip,
    row.identityLabel ? actorPassport(row.identityLabel) : null,
  );
  return true;
}

/**
 * Отзыв личности владельцем — SQL-руками по runbook'у `docs/passport-server.md`
 * (GUI-раздел паспорта — следующая веха). Каскад там же одной транзакцией:
 * строка реестра + её живые сессии. Сверх каскада отзыв проверяется на КАЖДОМ
 * чтении (`pullByToken`/`pushByToken` джойнят `passport_identity`), поэтому
 * забытый каскад не оставляет работающих артефактов — в отличие от голого
 * `enabled=false`, который ADR-0012 §5 называет декорацией.
 */
