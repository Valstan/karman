import { NextResponse } from 'next/server';
import { checkHotlineBearer, hotlineConfigured } from '@/lib/hotline/auth';
import { heartbeatPresence, readPresence, sweepStaleLines } from '@/lib/hotline/service';
import { hotlinePresenceSchema } from '@/lib/hotline/validation';

// Присутствие Телефона: POST — heartbeat «я в чате» (+ опциональное событие
// линии `line_state`), GET — кто жив и кто на проводе. Сторож (мандат 05.10):
// оба обработчика сначала гасят протухшие 'on_line' (два пропуска по 30с),
// таблица truthful без отдельного расписания — см. docs/hotline-relay.md.
// Та же защита, что у relay: fail-closed 503 без секрета, 401 чужому.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

export async function GET(req: Request) {
  if (!hotlineConfigured()) {
    return NextResponse.json({ error: 'hotline relay не настроен' }, { status: 503 });
  }
  if (!checkHotlineBearer(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const presence = await readPresence();
  return NextResponse.json({ presence }, NO_STORE);
}

export async function POST(req: Request) {
  if (!hotlineConfigured()) {
    return NextResponse.json({ error: 'hotline relay не настроен' }, { status: 503 });
  }
  if (!checkHotlineBearer(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body: unknown = await req.json().catch(() => null);
  const parsed = hotlinePresenceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad presence', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const done = await heartbeatPresence(
    parsed.data.label,
    parsed.data.alive_minutes,
    parsed.data.line_state,
  );
  const swept = await sweepStaleLines();
  return NextResponse.json({ ...done, swept_stale: swept }, { status: 201 });
}
