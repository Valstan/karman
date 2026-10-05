import 'server-only';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { authUser, secretsCard, secretsItem, secretsProject, secretsToken } from '@/lib/db/schema';
import { ACTOR_SYSTEM } from '@/lib/secrets/actor';
import { generateToken } from '@/lib/secrets/token';
import { isoNow, logAudit } from './internal';

/**
 * Self-serve provisioning — зона 3 `secrets.ts` (вынос 05.10, R3).
 *
 * Единственный путь, заводящий комнату и токен БЕЗ сессии владельца: гейт по
 * `VAULT_PROVISION_KEY` стоит в роуте, здесь — инварианты. Отдельная зона
 * потому, что её риск другой: операция не читает, а СОЗДАЁТ доступ, и потому
 * обязана быть максимально короткой и обозримой.
 *
 * Гейт по владельцу здесь обратный всем остальным зонам: комната вешается на
 * активного суперпользователя (`auth_user.is_superuser`), потому что владелец
 * один и он же распоряжается vault'ом.
 */

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
  // Дефолт `?? 1` (а не 0) — fail-closed: если счётчик не пришёл, комната
  // считается живой и переоткрытие отказывает. Перенесено из `secrets.ts`
  // дословно, поведение выноса не менялось.
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