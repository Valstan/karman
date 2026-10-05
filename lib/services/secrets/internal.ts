import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { secretsAudit, secretsProject } from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';

/**
 * Помощники, общие для зон `lib/services/secrets*` (вынос 05.10, R3).
 * Ничего не знают ни про одну зону — поэтому цикла импортов не возникает:
 * `secrets.ts`, `secrets/token.ts` и `secrets/cards.ts` берут помощники отсюда.
 */

export const isoNow = () => new Date().toISOString();

/**
 * id комнаты, если она принадлежит пользователю; иначе null. Суперпользователь
 * исключением НЕ является (решение владельца 03.09, `lib/auth/rbac.ts`) — он
 * администрирует аккаунты, но чужие комнаты видит только по согласию.
 */
export async function ownedProjectId(user: SessionUser, projectId: number): Promise<number | null> {
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
export async function logAudit(
  projectId: number | null,
  tokenId: number | null,
  action: string,
  detail: string | null,
  ip: string | null,
  actor: string | null = null,
): Promise<void> {
  await db.insert(secretsAudit).values({ projectId, tokenId, action, detail, ip, actor });
}