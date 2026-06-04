import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth/current-user';
import {
  getDocumentFilePath,
  getDocumentOwnerId,
  setDocumentFilePath,
} from '@/lib/services/documents';
import {
  contentTypeForPath,
  isDocumentFileSlot,
  saveDocumentFile,
  deleteFileByRelPath,
  fileExists,
  absolutePathFor,
} from '@/lib/storage/media';

// Файловый ввод-вывод требует Node runtime.
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string; slot: string }> };

async function resolveParams(ctx: Ctx) {
  const { id: rawId, slot } = await ctx.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0 || !isDocumentFileSlot(slot)) return null;
  return { id, slot };
}

const VALIDATION_MESSAGE: Record<string, string> = {
  type: 'Поддерживаются только JPG, PNG, WEBP или PDF',
  size: 'Файл больше 10 МБ',
  empty: 'Пустой файл',
};

/** Отдаёт файл слота (приватно, с проверкой владельца). */
export async function GET(_req: Request, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ message: 'Требуется авторизация' }, { status: 401 });

  const p = await resolveParams(ctx);
  if (!p) return NextResponse.json({ message: 'Некорректный запрос' }, { status: 400 });

  const relPath = await getDocumentFilePath(user, p.id, p.slot);
  if (!relPath || !(await fileExists(relPath))) {
    return NextResponse.json({ message: 'Файл не найден' }, { status: 404 });
  }

  const buffer = await readFile(absolutePathFor(relPath));
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': contentTypeForPath(relPath),
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, max-age=0, must-revalidate',
    },
  });
}

/** Загружает/заменяет файл слота. */
export async function POST(req: Request, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ message: 'Требуется авторизация' }, { status: 401 });

  const p = await resolveParams(ctx);
  if (!p) return NextResponse.json({ message: 'Некорректный запрос' }, { status: 400 });

  // Сначала убеждаемся в доступе и берём id владельца — файлы складываем под ним.
  const ownerId = await getDocumentOwnerId(user, p.id);
  if (ownerId === null) {
    return NextResponse.json({ message: 'Документ не найден' }, { status: 404 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ message: 'Файл не передан' }, { status: 400 });
  }

  let relPath: string;
  try {
    relPath = await saveDocumentFile(ownerId, p.id, p.slot, file);
  } catch (e) {
    const code = e instanceof Error ? e.message : 'type';
    return NextResponse.json({ message: VALIDATION_MESSAGE[code] ?? 'Не удалось сохранить файл' }, { status: 400 });
  }

  const previous = await setDocumentFilePath(user, p.id, p.slot, relPath);
  if (previous === undefined) {
    // документ исчез между проверками — убираем только что записанный файл
    await deleteFileByRelPath(relPath);
    return NextResponse.json({ message: 'Документ не найден' }, { status: 404 });
  }
  if (previous && previous !== relPath) await deleteFileByRelPath(previous);

  revalidatePath('/', 'layout');
  return NextResponse.json({ ok: true });
}

/** Удаляет файл слота. */
export async function DELETE(_req: Request, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ message: 'Требуется авторизация' }, { status: 401 });

  const p = await resolveParams(ctx);
  if (!p) return NextResponse.json({ message: 'Некорректный запрос' }, { status: 400 });

  const previous = await setDocumentFilePath(user, p.id, p.slot, null);
  if (previous === undefined) {
    return NextResponse.json({ message: 'Документ не найден' }, { status: 404 });
  }
  if (previous) await deleteFileByRelPath(previous);

  revalidatePath('/', 'layout');
  return NextResponse.json({ ok: true });
}
