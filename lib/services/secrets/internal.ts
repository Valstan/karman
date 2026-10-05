import 'server-only';
import { db } from '@/lib/db/client';
import { secretsAudit } from '@/lib/db/schema';

/**
 * Помощники, общие для зон `lib/services/secrets*` (вынос 05.10, R3).
 * Ничего не знают ни про одну зону — поэтому цикла импортов не возникает:
 * и `secrets.ts`, и `secrets/token.ts` берут помощники отсюда.
 */

export const isoNow = () => new Date().toISOString();

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