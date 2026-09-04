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
 * Гейт секретов для server actions (vault Ф2).
 *
 * Это ВТОРОЙ вход в раздел, независимый от `requireSecretsUser` в
 * `lib/auth/current-user.ts`: server action вызывается POST'ом по собственному
 * идентификатору из любого браузера с валидной cookie — гейт страницы его не
 * прикрывает. Поэтому проверка прав обязана стоять здесь тоже, иначе закрытие
 * раздела было бы косметическим: страница не открывается, а `revealItemAction`
 * по-прежнему отдаёт расшифрованный секрет.
 *
 * Условия те же и в том же порядке, что на страницах (там же и обоснование):
 * сначала суперпользователь (решение владельца 2026-09-04), затем второй фактор
 * при включённом 2FA.
 */
export async function requireSecretsAccess(): Promise<
  { user: SessionUser; error: null } | { user: null; error: string }
> {
  const user = await getCurrentUser();
  if (!user) return { user: null, error: 'Требуется авторизация' };
  if (!user.isSuperuser) return { user: null, error: 'Недостаточно прав' };
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
