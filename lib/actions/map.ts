'use server';

import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { loadBrainMap } from '@/lib/ecosystem/brain-map';

/**
 * «Обновить сейчас» на карте проектов (D-090): сбрасывает 10-минутный кэш и
 * перечитывает папку `docs/map` из репо Мозга. Ничего не пишет — только чтение,
 * поэтому доступна любому залогиненному, как и сама страница.
 */
export async function refreshMapAction(formData: FormData) {
  await requireUser();
  await loadBrainMap({ force: true });
  const tab = formData.get('tab');
  const slug = typeof tab === 'string' && /^[a-z0-9-]+$/.test(tab) ? tab : '';
  redirect(slug ? `/map?tab=${slug}` : '/map');
}
