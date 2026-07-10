import 'server-only';
import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth/current-user';
import { readSessionPayload } from '@/lib/auth/session';
import { totpEnabled } from '@/lib/services/twofactor';
import type { SessionUser } from '@/lib/auth/rbac';

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

export async function currentUserOrNull(): Promise<SessionUser | null> {
  return getCurrentUser();
}

/**
 * Гейт секретов для server actions (vault Ф2): при включённом 2FA мутации/reveal
 * секретов доступны только сессии, прошедшей второй фактор (mfa в JWT).
 */
export async function requireSecretsAccess(): Promise<
  { user: SessionUser; error: null } | { user: null; error: string }
> {
  const user = await getCurrentUser();
  if (!user) return { user: null, error: 'Требуется авторизация' };
  if (await totpEnabled(user.id)) {
    const payload = await readSessionPayload();
    if (!payload?.mfa) {
      return { user: null, error: 'Для доступа к секретам войдите заново (нужен код 2FA)' };
    }
  }
  return { user, error: null };
}

/** Инвалидирует все маршруты под корневым layout (после любой мутации). */
export function revalidateAll(): void {
  revalidatePath('/', 'layout');
}
