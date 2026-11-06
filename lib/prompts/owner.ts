import type { SessionUser } from '@/lib/auth/rbac';
import { resolveOwnerAccountId } from '@/lib/services/prompts';

/**
 * Аккаунт владельца для машинного канала промтов.
 *
 * Канал (`/api/prompts`) — это Мозг, который пишет по голосу владельца, а не
 * отдельный пользователь: сессии у него нет. Поэтому запись идёт от имени
 * ЖИВОГО АККАУНТА владельца — активного суперпользователя с наименьшим id.
 *
 * null — такого аккаунта нет: тогда канал отвечает 503. Писать «от кого-то
 * третьего» нельзя, и молча падать тоже нельзя — владелец должен узнать, что
 * его промты не записались.
 */
export async function ownerAccount(): Promise<SessionUser | null> {
  const id = await resolveOwnerAccountId();
  if (id === null) return null;
  return {
    id,
    username: 'owner',
    email: '',
    firstName: '',
    lastName: '',
    isSuperuser: true,
  };
}
