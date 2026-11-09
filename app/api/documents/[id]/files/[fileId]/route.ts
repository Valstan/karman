import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth/current-user';
import { deleteDocumentFileById, getDocumentFilePathById } from '@/lib/services/documents';
import { contentTypeForPath, deleteFileByRelPath, fileExists, absolutePathFor } from '@/lib/storage/media';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string; fileId: string }> };

async function resolveParams(ctx: Ctx) {
  const { id: rawId, fileId: rawFileId } = await ctx.params;
  const id = Number(rawId);
  const fileId = Number(rawFileId);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!Number.isInteger(fileId) || fileId <= 0) return null;
  return { id, fileId };
}

/** Отдаёт файл документа (приватно, с проверкой владельца). */
export async function GET(_req: Request, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ message: 'Требуется авторизация' }, { status: 401 });

  const p = await resolveParams(ctx);
  if (!p) return NextResponse.json({ message: 'Некорректный запрос' }, { status: 400 });

  const relPath = await getDocumentFilePathById(user, p.id, p.fileId);
  if (!relPath || !(await fileExists(relPath))) {
    return NextResponse.json({ message: 'Файл не найден' }, { status: 404 });
  }

  // `readFile` уже отдаёт Buffer (подтип Uint8Array). Обёртка `new Uint8Array(buffer)`
  // копировала файл ВТОРЫМ разом: на файле в 10 МБ это две копии в памяти сервера
  // (аудит #057, D6). Тело отдаём самим Buffer — копия одна.
  const buffer = await readFile(absolutePathFor(relPath));
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': contentTypeForPath(relPath),
      'Content-Disposition': 'inline',
      // Приватный файл: кеширование запрещаем явно, иначе он оседает у прокси
      // и остаётся доступен после отзыва доступа.
      'Cache-Control': 'private, max-age=0, must-revalidate',
    },
  });
}

/** Удаляет файл документа (запись и сам файл). */
export async function DELETE(_req: Request, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ message: 'Требуется авторизация' }, { status: 401 });

  const p = await resolveParams(ctx);
  if (!p) return NextResponse.json({ message: 'Некорректный запрос' }, { status: 400 });

  const relPath = await deleteDocumentFileById(user, p.id, p.fileId);
  if (relPath === null) return NextResponse.json({ message: 'Файл не найден' }, { status: 404 });

  await deleteFileByRelPath(relPath);
  revalidatePath('/', 'layout');
  return NextResponse.json({ ok: true });
}
