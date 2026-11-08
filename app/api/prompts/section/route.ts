import { NextResponse } from 'next/server';
import { clientIp } from '@/lib/api/client-ip';
import { rateLimit } from '@/lib/secrets/rate-limit';
import { resolveSectionByToken } from '@/lib/prompts/section-auth';
import { listSectionPrompts, setPromptArchivedInSection } from '@/lib/services/prompts';

/**
 * Раздел библиотеки промтов — машинный доступ ПРОЕКТА (заказ владельца
 * 2026-11-08).
 *
 * GET  `?project=<Раздел>&archived=1` — промты раздела: живые (по умолчанию) или
 *      архивные. Раздел берётся из ТОКЕНА, а не из доверия к запросу: токен
 *      раздела — единственное право на этот раздел.
 *
 * POST `{ project, id, archived? }` — отправить промт раздела в архив (или
 *      вернуть из архива). Проект архивирует промт **после выполнения** задания:
 *      архив = «сделано», а не «взял в работу».
 *
 * Отличия от `/api/prompts` (канал Мозга): там секрет один и он ПИШЕТ от имени
 * владельца; здесь у каждого раздела свой токен, и раздел читает и архивирует
 * только свой. Секрет раздела лежит в комнате проекта (vault) и раздаётся тем
 * же каналом, что остальные секреты.
 *
 * Fail-closed: секрет раздела не задан — 503 («не настроено»); токен чужой или
 * не от того раздела — 403; промт не найден в разделе — 404.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

function denied(reason: 'not_configured' | 'unauthorized'): Response {
  if (reason === 'not_configured') {
    return NextResponse.json({ error: 'канал промтов раздела не настроен' }, { status: 503 });
  }
  return NextResponse.json({ error: 'unauthorized' }, { status: 403 });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const resolved = await resolveSectionByToken(
    req.headers.get('authorization'),
    url.searchParams.get('project'),
  );
  if (!resolved.ok) {
    return denied(resolved.reason);
  }
  const archived = url.searchParams.get('archived') === '1';
  const prompts = await listSectionPrompts(resolved.section, { archived });
  return NextResponse.json({ project: resolved.section, prompts }, NO_STORE);
}

export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  const raw = (body ?? {}) as { project?: unknown; id?: unknown; archived?: unknown };
  const project = typeof raw.project === 'string' ? raw.project : '';
  const id = Number(raw.id);
  const archived = raw.archived !== false;

  const resolved = await resolveSectionByToken(req.headers.get('authorization'), project);
  if (!resolved.ok) {
    return denied(resolved.reason);
  }
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'bad id' }, { status: 400 });
  }
  if (!rateLimit(`prompts-section|${clientIp(req) ?? '-'}`)) {
    return NextResponse.json({ error: 'Слишком много запросов' }, { status: 429 });
  }
  const ok = await setPromptArchivedInSection(resolved.section, id, archived);
  if (!ok) {
    return NextResponse.json({ error: 'промт не найден в разделе' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, project: resolved.section, id, archived }, NO_STORE);
}
