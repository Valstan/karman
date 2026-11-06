import { NextResponse } from 'next/server';
import { clientIp } from '@/lib/api/client-ip';
import { rateLimit } from '@/lib/secrets/rate-limit';
import { checkPromptsBearer, promptsConfigured } from '@/lib/prompts/auth';
import { ownerAccount } from '@/lib/prompts/owner';
import { listPromptSections, syncPromptProjects } from '@/lib/services/prompts';

/**
 * Реестр разделов библиотеки промтов (машинный канал Мозга).
 *
 * POST — синхронизация канона: Мозг присылает список разделов экосистемы, и они
 * заводятся заранее (пустые тоже видны). Только добавление: чужие разделы не
 * трогаются и не пропадают — канон может прийти неполным.
 *
 * GET — текущий список разделов владельца (для проверки, что канон доехал).
 *
 * Тот же секрет, что у записи промтов: `PROMPTS_INGEST_SECRET`, fail-closed.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

export async function GET(req: Request) {
  if (!(await promptsConfigured())) {
    return NextResponse.json({ error: 'канал промтов не настроен' }, { status: 503 });
  }
  if (!(await checkPromptsBearer(req.headers.get('authorization')))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const owner = await ownerAccount();
  if (!owner) {
    return NextResponse.json({ error: 'нет живого аккаунта владельца' }, { status: 503 });
  }
  const sections = await listPromptSections(owner, { archived: false });
  return NextResponse.json({ sections }, NO_STORE);
}

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
  const projects =
    body && typeof body === 'object' && Array.isArray((body as { projects?: unknown }).projects)
      ? ((body as { projects: unknown[] }).projects.filter(
          (name): name is string => typeof name === 'string',
        ))
      : null;
  if (!projects) {
    return NextResponse.json({ error: 'ожидается { projects: [...] }' }, { status: 400 });
  }
  const added = await syncPromptProjects(owner, projects);
  const sections = await listPromptSections(owner, { archived: false });
  return NextResponse.json({ added, sections }, NO_STORE);
}
