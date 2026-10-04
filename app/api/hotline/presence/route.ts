import { NextResponse } from 'next/server';
import { checkHotlineBearer, hotlineConfigured } from '@/lib/hotline/auth';
import { heartbeatPresence, readPresence } from '@/lib/hotline/service';
import { hotlinePresenceSchema } from '@/lib/hotline/validation';

// Присутствие Телефона: POST — heartbeat «я в чате», GET — кто жив.
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
  const done = await heartbeatPresence(parsed.data.label, parsed.data.alive_minutes);
  return NextResponse.json(done, { status: 201 });
}
