import { NextResponse } from 'next/server';
import { checkInternalBearer } from '@/lib/telegram/config';

// Диспетчер напоминаний — вызывается воркером по таймеру (Bearer-секрет).
// P0: скелет. Due-scan/отправка/пересчёт next_fire_at — P1
// (lib/services/reminder-dispatch.ts), с advisory-lock и идемпотентным claim слота.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!checkInternalBearer(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  return NextResponse.json({ scanned: 0, sent: 0, failed: 0, deferred: 0, note: 'p0-skeleton' });
}
