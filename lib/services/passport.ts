import 'server-only';
import { and, count, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
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
import { actorOwner, actorPassport } from '@/lib/secrets/actor';
import { isUniqueViolation } from '@/lib/db/pg-error';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import type { PassportIdentityCreateInput } from '@/lib/validation/secret';
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

// --- Реестр личностей: чтение и мутации из GUI (веха 2 ADR-0012) ------------
//
// До вехи 2 реестр вёлся SQL-runbook'ом: владелец ходил в psql на прод, и так
// заведены все живые строки. Здесь тот же runbook, но функциями — с проверкой
// владения комнатой, аудитом и каскадом отзыва в одной транзакции.
//
// Владения у самой строки реестра нет: `passport_identity` не несёт `user_id`,
// а указывает на комнату. Значит, право на личность — это право на её КОМНАТУ,
// и проверяется оно ровно так же, как везде в менеджере секретов (`ownership`).

export type PassportIdentityRow = {
  id: number;
  label: string;
  identityValue: string;
  issuerId: number;
  issuerName: string;
  projectId: number;
  projectSlug: string;
  projectName: string;
  canWrite: boolean;
  note: string | null;
  createdAt: string;
  revokedAt: string | null;
  /** Сколько сессий этой личности живы прямо сейчас (не отозваны и не истекли). */
  liveSessions: number;
  /**
   * Когда личность в последний раз открывала сессию. `null` — ни разу.
   *
   * Это единственный признак опечатки в идентификаторе, доступный владельцу
   * комнаты: отказ «личность вне реестра» пишется строкой с `project_id = NULL`,
   * а её в комнате не видно. Личность, которая неделю числится заведённой и ни
   * разу не входила, — почти всегда неверный номер репозитория.
   */
  lastSessionAt: string | null;
};

export type PassportIssuerOption = {
  id: number;
  issuer: string;
  identityClaim: string;
};

/**
 * Строки реестра, видимые пользователю: только личности его комнат (superuser
 * видит все). Отозванные не прячутся — по ним читают историю, и без них экран
 * врёт, будто личности никогда не было.
 */
export async function listIdentities(user: SessionUser): Promise<PassportIdentityRow[]> {
  const rows = await db
    .select({
      id: passportIdentity.id,
      label: passportIdentity.label,
      identityValue: passportIdentity.identityValue,
      issuerId: passportIdentity.issuerId,
      issuerName: passportIssuer.issuer,
      projectId: passportIdentity.projectId,
      projectSlug: secretsProject.slug,
      projectName: secretsProject.name,
      canWrite: passportIdentity.canWrite,
      note: passportIdentity.note,
      createdAt: passportIdentity.createdAt,
      revokedAt: passportIdentity.revokedAt,
    })
    .from(passportIdentity)
    .innerJoin(secretsProject, eq(secretsProject.id, passportIdentity.projectId))
    .innerJoin(passportIssuer, eq(passportIssuer.id, passportIdentity.issuerId))
    .where(ownership(user, secretsProject.userId))
    .orderBy(desc(passportIdentity.id));
  if (rows.length === 0) return [];

  // Сессии считаем одним запросом на всех, а не построчно: реестр сейчас
  // маленький, но N+1 здесь вырос бы вместе с ним молча.
  const ids = rows.map((r) => r.id);
  const now = isoNow();
  const stats = await db
    .select({
      identityId: secretsToken.identityId,
      live: count(
        // Живая = не отозвана И не истекла. Бессрочная (`expires_at IS NULL`)
        // считается живой: ровно так её читает `resolveApiToken`, а разойтись
        // с ним значило бы показывать владельцу не то, что решает доступ.
        // Паспортная сессия срок получает всегда, но предикат обязан описывать
        // правило, а не сегодняшнее везение.
        sql`case when ${secretsToken.revokedAt} is null
                  and (${secretsToken.expiresAt} is null or ${secretsToken.expiresAt} > ${now})
             then 1 end`,
      ),
      lastSessionAt: sql<string | null>`max(${secretsToken.createdAt})`,
    })
    .from(secretsToken)
    .where(inArray(secretsToken.identityId, ids))
    .groupBy(secretsToken.identityId);
  const byIdentity = new Map(stats.map((s) => [s.identityId, s]));

  return rows.map((r) => {
    const s = byIdentity.get(r.id);
    return {
      ...r,
      liveSessions: Number(s?.live ?? 0),
      lastSessionAt: s?.lastSessionAt ?? null,
    };
  });
}

/**
 * Доверенные издатели для формы. Выключенный не предлагается: он всё равно не пустит.
 *
 * Отдаются только те поля, которые нужны форме. `audience` и `subject_pattern` —
 * настройки акцептора, и уезжать в браузер им незачем: пропсы клиентского
 * компонента сериализуются в payload страницы независимо от того, отрисованы
 * они или нет.
 */
export async function listIssuers(): Promise<PassportIssuerOption[]> {
  return db
    .select({
      id: passportIssuer.id,
      issuer: passportIssuer.issuer,
      identityClaim: passportIssuer.identityClaim,
    })
    .from(passportIssuer)
    .where(eq(passportIssuer.enabled, true))
    .orderBy(passportIssuer.id);
}

export type IdentityMutationResult = { ok: true; id: number } | { ok: false; error: string };

/**
 * Заводит личность.
 *
 * **Заведение — только владелец vault (superuser), и это не перестраховка.**
 * Пространство `(issuer_id, identity_value)` ГЛОБАЛЬНО: уникальный индекс не
 * знает про пользователя. Комнату при этом заводит любой вошедший, а вошедшим
 * становится любой, кто успешно прошёл вход через ЕСА (`resolveOidcLogin`
 * заводит активного пользователя без аллоулиста). Без этого гейта посторонний
 * зарегистрировал бы `repository_id` ЧУЖОГО репозитория на свою комнату — и
 * увёл бы туда чужой CI. До вехи 2 реестр был «только руками владельца»;
 * интерфейс не должен молча превращать это в самообслуживание.
 *
 * Комната обязана существовать и принадлежать пользователю: автозаведение
 * комнаты и автовывод slug'а из имени репозитория запрещены (ADR-0012 §5 —
 * вывод не инъективен, а в vault уже заводились мусорные комнаты).
 */
export async function createIdentity(
  user: SessionUser,
  input: PassportIdentityCreateInput,
): Promise<IdentityMutationResult> {
  if (!user.isSuperuser) {
    return { ok: false, error: 'Заводить личности может только владелец vault' };
  }

  const [project] = await db
    .select({ id: secretsProject.id, slug: secretsProject.slug })
    .from(secretsProject)
    .where(and(eq(secretsProject.id, input.projectId), ownership(user, secretsProject.userId)))
    .limit(1);
  if (!project) return { ok: false, error: 'Комната не найдена' };

  const [issuer] = await db
    .select({ id: passportIssuer.id })
    .from(passportIssuer)
    .where(and(eq(passportIssuer.id, input.issuerId), eq(passportIssuer.enabled, true)))
    .limit(1);
  if (!issuer) return { ok: false, error: 'Издатель удостоверений не найден или выключен' };

  // Уникальный индекс частичный — (issuer_id, identity_value) WHERE revoked_at IS NULL.
  // Отозванная личность НЕ мешает завести её заново, и это штатный путь смены
  // прав: `can_write` у выданной сессии поменять нельзя, только перевыпустить.
  // Предпроверка нужна ради внятного текста; корректность даёт индекс (ниже).
  const [dup] = await db
    .select({
      id: passportIdentity.id,
      label: passportIdentity.label,
      ownerId: secretsProject.userId,
    })
    .from(passportIdentity)
    .innerJoin(secretsProject, eq(secretsProject.id, passportIdentity.projectId))
    .where(
      and(
        eq(passportIdentity.issuerId, input.issuerId),
        eq(passportIdentity.identityValue, input.identityValue),
        isNull(passportIdentity.revokedAt),
      ),
    )
    .limit(1);
  if (dup) {
    // Запрос дубля идёт БЕЗ фильтра владения — иначе он не увидел бы занятую
    // строку и INSERT всё равно упал бы индексом. Но метку чужой личности в
    // текст не подставляем: форма превратилась бы в перебор чужого реестра.
    const mine = user.isSuperuser || dup.ownerId === user.id;
    return {
      ok: false,
      error: mine
        ? `Идентификатор ${input.identityValue} уже заведён — «${dup.label}». Чтобы сменить комнату или права, отзовите личность и заведите заново.`
        : `Идентификатор ${input.identityValue} уже заведён в этом vault.`,
    };
  }

  let id: number;
  try {
    const [created] = await db
      .insert(passportIdentity)
      .values({
        issuerId: input.issuerId,
        identityValue: input.identityValue,
        label: input.label,
        projectId: project.id,
        canWrite: input.canWrite,
        note: input.note ?? null,
      })
      .returning({ id: passportIdentity.id });
    id = created!.id;
  } catch (e) {
    // Гонка: между предпроверкой и вставкой успел встрять параллельный запрос.
    // `onConflictDoNothing` здесь неприменим — индекс частичный, на такой target
    // Postgres отвечает 42P10.
    if (isUniqueViolation(e)) {
      return { ok: false, error: `Идентификатор ${input.identityValue} уже заведён в этом vault.` };
    }
    throw e;
  }

  await logAudit(
    project.id,
    null,
    'identity_created',
    `личность ${input.label} (${input.identityValue}) → комната «${project.slug}», ${input.canWrite ? 'запись разрешена' : 'только чтение'}`,
    null,
    actorOwner(user.id),
  );
  return { ok: true, id };
}

/**
 * Отзыв личности владельцем — КАСКАДОМ: строка реестра и её живые сессии гаснут
 * одной транзакцией. Голый `revoked_at` у личности без каскада — декорация:
 * она уже выпустила токены, и они пережили бы отзыв до конца своего TTL.
 *
 * Сверх каскада отзыв проверяется на КАЖДОМ чтении (`resolveApiToken` джойнит
 * `passport_identity`), поэтому даже недогашенный токен читать уже не может.
 * Каскад закрывает окно, проверка на чтении — само право; вместе они дают то,
 * что ADR-0012 §5 противопоставляет голому `enabled=false`.
 */
export async function revokeIdentity(
  user: SessionUser,
  identityId: number,
): Promise<({ ok: true; id: number; killed: number } | { ok: false; error: string })> {
  const [row] = await db
    .select({
      id: passportIdentity.id,
      label: passportIdentity.label,
      projectId: passportIdentity.projectId,
      projectSlug: secretsProject.slug,
      revokedAt: passportIdentity.revokedAt,
    })
    .from(passportIdentity)
    .innerJoin(secretsProject, eq(secretsProject.id, passportIdentity.projectId))
    .where(and(eq(passportIdentity.id, identityId), ownership(user, secretsProject.userId)))
    .limit(1);
  if (!row) return { ok: false, error: 'Личность не найдена' };
  if (row.revokedAt) return { ok: false, error: 'Личность уже отозвана' };

  const now = isoNow();
  const killed = await db.transaction(async (tx) => {
    await tx.update(passportIdentity).set({ revokedAt: now }).where(eq(passportIdentity.id, row.id));
    const sessions = await tx
      .update(secretsToken)
      .set({ revokedAt: now })
      .where(and(eq(secretsToken.identityId, row.id), isNull(secretsToken.revokedAt)))
      .returning({ id: secretsToken.id });
    return sessions.length;
  });

  await logAudit(
    row.projectId,
    null,
    'identity_revoked',
    `личность ${row.label} отозвана; погашено сессий: ${killed}`,
    null,
    actorOwner(user.id),
  );
  return { ok: true, id: row.id, killed };
}
