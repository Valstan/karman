import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Публичный сторож: `scripts/health_watch.sh` бьёт его каждые 10 минут и ждёт ровно
 * `{status:"ok"}` при 200. Публичность — сознательное решение (иначе сторож был бы
 * заперт вместе с приложением, ради проверки которого существует).
 *
 * Поэтому публичность обязан означать и сдержанность ответа: текст ошибки драйвера в
 * теле 500 уходил наружу, а это ровно хост, порт, имя БД и роль Postgres — класс,
 * запрещённый D-038 для недоверенных поверхностей. Причина уходит в журнал сервиса, оттуда
 * её уже забирает `journalctl` в шаге «On failure» деплоя (аудит #057, H1).
 */
export async function GET() {
  try {
    await db.execute(sql`SELECT 1`);
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    console.error('[health] db check failed', error);
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}
