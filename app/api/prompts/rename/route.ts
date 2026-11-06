import { NextResponse } from 'next/server';
import { clientIp } from '@/lib/api/client-ip';
import { rateLimit } from '@/lib/secrets/rate-limit';
import { checkPromptsBearer, promptsConfigured } from '@/lib/prompts/auth';
import { ownerAccount } from '@/lib/prompts/owner';
import { renamePromptProject } from '@/lib/services/prompts';

/**
 * Переименование раздела библиотеки (машинный канал Мозга).
 *
 * Нужно, когда канон экосистемы меняется: раздел «МАТРИЦА РМЗ» → «MatricaRMZ»,
 * иначе один проект живёт в двух разделах (заказ владельца 2026-11-06).
 *
 * Переименование тянет за собой промты раздела. Если раздел с новым именем уже
 * есть, они сливаются: промты переезжают, старый раздел исчезает.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!(await promptsConfigured())) {
    return NextResponse.json({ error: 'канал промтов не настроен' }, { status: 503 });
  }
  if (!(await checkPromptsBearer(req.headers.get('authorization')))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!rateLimit(`prompts|${clientIp(req) ?? '-'}`)) {
    return NextResponse.json({ error: 'Слишком много запросов' }, { status: 429 });
  }
  const owner = await ownerAccount();
  if (!owner) {
    return NextResponse.json({ error: 'нет живого аккаунта владельца' }, { status: 503 });
  }
  const body: unknown = await req.json().catch(() => null);
  const from =
    body && typeof body === 'object' && typeof (body as { from?: unknown }).from === 'string'
      ? ((body as { from: string }).from)
      : '';
  const to =
    body && typeof body === 'object' && typeof (body as { to?: unknown }).to === 'string'
      ? ((body as { to: string }).to)
      : '';
  if (!from || !to) {
    return NextResponse.json({ error: 'ожидается { from, to }' }, { status: 400 });
  }
  const renamed = await renamePromptProject(owner, from, to);
  if (!renamed) {
    return NextResponse.json({ error: 'раздел не найден или имя невалидно' }, { status: 404 });
  }
  return NextResponse.json({ renamed, from, to });
}
