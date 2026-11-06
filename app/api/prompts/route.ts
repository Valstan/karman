import { NextResponse } from 'next/server';
import { clientIp } from '@/lib/api/client-ip';
import { rateLimit } from '@/lib/secrets/rate-limit';
import { checkPromptsBearer, promptsConfigured } from '@/lib/prompts/auth';
import { ownerAccount } from '@/lib/prompts/owner';
import { createPrompt, listPrompts } from '@/lib/services/prompts';
import { promptCreateSchema } from '@/lib/validation/prompt';

/**
 * Канал промтов Мозга (заказ владельца 2026-11-06).
 *
 * POST — Мозг складывает надиктованный промт в библиотеку КАРМАНА: проект
 * (раздел), необязательный заголовок и сам текст. GET — прочитать библиотеку
 * (Мозг подтягивает промты проекта, когда работает над ним).
 *
 * Библиотека ЛИЧНАЯ, но канал машинный: сессии у него нет, и промт пишется по
 * голосу владельца. Поэтому запись идёт от имени ЖИВОГО АККАУНТА владельца
 * (активный суперпользователь с наименьшим id) — того самого, под которым он
 * входит в КАРМАН. Промт без хозяина не пишется: если живого аккаунта нет,
 * канал отвечает 503, а не создаёт запись «от кого-то третьего».
 *
 * GET отдаёт библиотеку ВЛАДЕЛЬЦА (того же аккаунта) — иначе Мозг читал бы
 * чужое.
 *
 * proxy.ts не трогает /api/* → защищаемся сами общим секретом канала
 * (PROMPTS_INGEST_SECRET). Fail-closed: секрет не задан — 503 (не настроено),
 * чужой токен — 401.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

async function denied(): Promise<Response | null> {
  if (!(await promptsConfigured())) {
    return NextResponse.json({ error: 'канал промтов не настроен' }, { status: 503 });
  }
  return null;
}

export async function GET(req: Request) {
  const off = await denied();
  if (off) return off;
  if (!(await checkPromptsBearer(req.headers.get('authorization')))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const owner = await ownerAccount();
  if (!owner) {
    return NextResponse.json({ error: 'нет живого аккаунта владельца' }, { status: 503 });
  }
  const url = new URL(req.url);
  const project = url.searchParams.get('project') ?? undefined;
  const archived = url.searchParams.get('archived') === '1';
  const prompts = await listPrompts(owner, { archived, project });
  return NextResponse.json({ prompts }, NO_STORE);
}

export async function POST(req: Request) {
  const off = await denied();
  if (off) return off;
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
  const parsed = promptCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad prompt', issues: parsed.error.issues }, { status: 400 });
  }
  const created = await createPrompt(owner, parsed.data, 'brain');
  return NextResponse.json(
    {
      id: created.id,
      project: created.project,
      title: created.title,
      created_at: created.createdAt,
    },
    { status: 201 },
  );
}
