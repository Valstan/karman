import { NextResponse } from 'next/server';
import { checkInternalBearer } from '@/lib/telegram/config';
import { dispatchDueReminders } from '@/lib/services/reminder-dispatch';

// Диспетчер напоминаний — вызывается воркером по таймеру (Bearer-секрет).
// proxy.ts не трогает /api/* → защищаемся сами. Single-flight advisory-lock +
// идемпотентный claim слота внутри dispatchDueReminders.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!checkInternalBearer(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await dispatchDueReminders();
    return NextResponse.json(result);
  } catch (error) {
    console.error('[reminders/dispatch] error', error);
    return NextResponse.json({ error: 'dispatch failed' }, { status: 500 });
  }
}
