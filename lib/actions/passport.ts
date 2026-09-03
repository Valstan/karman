'use server';

import { createIdentity, revokeIdentity } from '@/lib/services/passport';
import { passportIdentityCreateSchema } from '@/lib/validation/secret';
import { requireSecretsAccess, revalidateAll, type ActionResult } from './_internal';

/**
 * Реестр личностей паспорта из GUI (веха 2 ADR-0012). Гейт тот же, что у всего
 * менеджера секретов: `requireSecretsAccess` требует пройденного второго
 * фактора, если он включён. Это не формальность — экран раздаёт доступ к чужим
 * секретам, и его цена выше, чем у обычной страницы приложения.
 */
export async function createIdentityAction(values: unknown): Promise<ActionResult<{ id: number }>> {
  const guard = await requireSecretsAccess();
  if (guard.user === null) return { ok: false, error: guard.error };
  const user = guard.user;
  const parsed = passportIdentityCreateSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  const result = await createIdentity(user, parsed.data);
  if (!result.ok) return { ok: false, error: result.error };
  revalidateAll();
  return { ok: true, data: { id: result.id } };
}

/**
 * Отзыв личности каскадом: строка реестра и её живые сессии гаснут вместе.
 *
 * Число погашенных сессий возвращается наружу, а не только в аудит: владелец
 * жмёт «отозвать» именно затем, чтобы чужой CI перестал ходить в комнату, и
 * «отозвано, погашено 2 сессии» отвечает на этот вопрос, а «готово» — нет.
 */
export async function revokeIdentityAction(id: number): Promise<ActionResult<{ killed: number }>> {
  const guard = await requireSecretsAccess();
  if (guard.user === null) return { ok: false, error: guard.error };
  const user = guard.user;
  const result = await revokeIdentity(user, id);
  if (!result.ok) return { ok: false, error: result.error };
  revalidateAll();
  return { ok: true, data: { killed: result.killed } };
}
