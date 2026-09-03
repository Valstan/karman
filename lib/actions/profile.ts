'use server';

import { profileUpsertSchema } from '@/lib/validation/profile';
import { upsertOwnProfile } from '@/lib/services/profile';
import { currentUserOrNull, revalidateAll, type ActionResult } from './_internal';

/** Сохраняет СВОЮ карточку. Чужую этим действием не тронуть: userId берётся из сессии. */
export async function saveProfileAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = profileUpsertSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  await upsertOwnProfile(user, parsed.data);
  revalidateAll();
  return { ok: true };
}
