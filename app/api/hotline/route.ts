import { NextResponse } from 'next/server';
import { clientIp } from '@/lib/api/client-ip';
import { checkHotlineBearer, hotlineConfigured } from '@/lib/hotline/auth';
import { hotlineLint } from '@/lib/hotline/lint';
import { rateLimit } from '@/lib/secrets/rate-limit';
import { postHotlineMessage, readHotlineMessages } from '@/lib/hotline/service';
import { hotlinePostSchema, hotlineReadSchema } from '@/lib/hotline/validation';

// Relay Телефона (Ф1, v2-a): POST — написать в комнату, GET — читать ленту.
// proxy.ts не трогает /api/* → защищаемся сами общим секретом relay.
// Fail-closed: секрет не задан — 503 (не настроено), чужой токен — 401.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

function denied() {
  if (!hotlineConfigured()) {
    return NextResponse.json({ error: 'hotline relay не настроен' }, { status: 503 });
  }
  return null;
}

export async function GET(req: Request) {
  const off = denied();
  if (off) return off;
  if (!checkHotlineBearer(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const url = new URL(req.url);
  const parsed = hotlineReadSchema.safeParse({
    room: url.searchParams.get('room'),
    since_id: url.searchParams.get('since_id') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad query', issues: parsed.error.issues }, { status: 400 });
  }
  const messages = await readHotlineMessages(
    parsed.data.room,
    parsed.data.since_id,
    parsed.data.limit,
  );
  return NextResponse.json({ messages }, NO_STORE);
}

export async function POST(req: Request) {
  const off = denied();
  if (off) return off;
  if (!checkHotlineBearer(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!rateLimit(`hotline|${clientIp(req) ?? '-'}`)) {
    return NextResponse.json({ error: 'Слишком много запросов' }, { status: 429 });
  }
  const body: unknown = await req.json().catch(() => null);
  const parsed = hotlinePostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad message', issues: parsed.error.issues }, { status: 400 });
  }
  const lintHit = hotlineLint(parsed.data.text);
  if (lintHit) {
    return NextResponse.json(
      { error: 'текст отклонён серверным линтом', pattern: lintHit },
      { status: 400 },
    );
  }
  const row = await postHotlineMessage({
    room: parsed.data.room,
    sender: parsed.data.from,
    kind: parsed.data.kind,
    text: parsed.data.text,
  });
  return NextResponse.json({ id: row?.id, created_at: row?.createdAt }, { status: 201 });
}
