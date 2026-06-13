import 'server-only';
import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth/current-user';
import type { SessionUser } from '@/lib/auth/rbac';

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

export async function currentUserOrNull(): Promise<SessionUser | null> {
  return getCurrentUser();
}

/** Инвалидирует все маршруты под корневым layout (после любой мутации). */
export function revalidateAll(): void {
  revalidatePath('/', 'layout');
}
