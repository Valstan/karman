import 'server-only';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  passportIdentity,
  secretsGrant,
  secretsItem,
  secretsProject,
  secretsToken,
} from '@/lib/db/schema';
import { decryptSecret, encryptSecret, secretAad } from '@/lib/secrets/crypto';
import { hashToken, looksLikeToken } from '@/lib/secrets/token';
import { actorPassport, actorToken } from '@/lib/secrets/actor';
import { resolveGrants, type GrantAlias } from '@/lib/secrets/grant';
import { isoNow, logAudit } from './internal';

/**
 * Машинный доступ по токену — зона 5 `secrets.ts` (вынос 05.10, R3).
 *
 * Все три функции проходят через один гейт `resolveApiToken` (срок, отзыв
 * токена, отзыв личности) — это и есть смысл зоны: читателю файла не нужно
 * знать про комнаты, карточки, выдачи и provisioning, чтобы прочитать чужую
 * границу доверия. Значения приходят из `secrets_item` расшифрованными,
 * выданные (grant) ключи — из исходной записи источника.
 *
 * Общие с родительским модулем помощники приходят из `./internal`: `logAudit`,
 * `isoNow`. Цикла импортов нет — `internal` ничего не знает про эту зону.
 */

export type ResolvedToken = {
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
export async function resolveApiToken(rawToken: string): Promise<TokenResolution> {
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
  | { ok: false; status: 401 | 500; error: string }
  // 404 несёт список промахов: потребитель обязан видеть, ЧЕГО не выдали (G331).
  | { ok: false; status: 404; error: string; missing: string[] };

/**
 * Выдаёт секреты проекта по токену (plaintext). Проверяет токен по хэшу, пишет
 * аудит, обновляет last_used_at. keyFilter — вернуть только перечисленные ключи;
 * промах любого из них — 404 с `missing` (G331: пустая выдача обязана быть громкой,
 * молчание — только для запроса без фильтра, где «ожидалось что есть»).
 */
export async function pullByToken(
  rawToken: string,
  ip: string | null,
  keyFilter?: string | string[],
): Promise<PullResult> {
  const wanted = keyFilter === undefined ? undefined : Array.isArray(keyFilter) ? keyFilter : [keyFilter];
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

    if (wanted !== undefined) {
      const missing = wanted.filter((k) => !(k in secrets));
      if (missing.length > 0) {
        await logAudit(tok.projectId, tok.id, 'pull_miss', missing.join(','), ip, actor);
        return {
          ok: false,
          status: 404,
          error: `Не найдено ключей: ${missing.length} из ${wanted.length}`,
          missing,
        };
      }
      await logAudit(tok.projectId, tok.id, 'pull', `key=${wanted.join(',')}`, ip, actor);
      const asked = new Set(wanted);
      await logGrantReads(
        tok.projectId,
        delivered.filter((g) => asked.has(g.aliasKey)),
        ip,
        actor,
      );
      const picked: Record<string, string> = {};
      for (const k of wanted) {
        picked[k] = secrets[k]!;
      }
      return { ok: true, secrets: picked };
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

/**
 * Действующие выдачи, по которым комната-получатель читает чужие ключи.
 * Предложения (`accepted_at IS NULL`) сюда НЕ входят — в этом и состоит
 * согласие получателя: до accept чужое имя в его окружении не появляется.
 */
async function activeGrantsFor(targetProjectId: number): Promise<GrantAlias[]> {
  return db
    .select({
      id: secretsGrant.id,
      sourceProjectId: secretsGrant.sourceProjectId,
      sourceKey: secretsGrant.sourceKey,
      aliasKey: secretsGrant.aliasKey,
    })
    .from(secretsGrant)
    .where(
      and(
        eq(secretsGrant.targetProjectId, targetProjectId),
        isNull(secretsGrant.revokedAt),
        isNotNull(secretsGrant.acceptedAt),
      ),
    );
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