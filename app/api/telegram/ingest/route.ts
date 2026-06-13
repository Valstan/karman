import { NextResponse } from 'next/server';
import { checkInternalBearer } from '@/lib/telegram/config';
import { handleUpdate } from '@/lib/telegram/handle-update';
import type { TgUpdate } from '@/lib/telegram/types';

// Реле входящих Telegram-апдейтов от воркера (scripts/reminders-worker.mjs).
// proxy.ts не трогает /api/* → защищаемся сами Bearer-секретом.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!checkInternalBearer(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const update = (await req.json().catch(() => null)) as TgUpdate | null;
  if (!update || typeof update.update_id !== 'number') {
    return NextResponse.json({ error: 'bad update' }, { status: 400 });
  }

  try {
    await handleUpdate(update);
  } catch (error) {
    console.error('[telegram/ingest] handle error', error);
    // 200, чтобы воркер не зацикливал тот же апдейт; ошибку логируем.
    return NextResponse.json({ ok: true, handled: false });
  }

  return NextResponse.json({ ok: true });
}
