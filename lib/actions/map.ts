'use server';

import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { loadBrainMap } from '@/lib/ecosystem/brain-map';

/**
 * «Обновить сейчас» на карте проектов (D-090): сбрасывает 10-минутный кэш и
 * перечитывает папку `docs/map` из репо Мозга. Ничего не пишет — только чтение.
 *
 * Только владелец (заказ владельца 2026-11-06): карта проектов — его личная
 * страница, и перечитывать её содержимое (хосты, порты) ради чужого аккаунта
 * незачем. Кнопка на странице у не-владельца и не показывается.
 */
export async function refreshMapAction(formData: FormData) {
  const user = await requireUser();
  if (!user.isSuperuser) {
    redirect('/map');
  }
  await loadBrainMap({ force: true, includeContent: true });
  const tab = formData.get('tab');
  const slug = typeof tab === 'string' && /^[a-z0-9-]+$/.test(tab) ? tab : '';
  redirect(slug ? `/map?tab=${slug}` : '/map');
}
