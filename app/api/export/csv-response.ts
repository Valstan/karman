import { NextResponse } from 'next/server';

/** CSV-ответ с заголовком на скачивание (ASCII-имя файла во избежание проблем с кодировкой). */
export function csvResponse(filename: string, body: string): NextResponse {
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
