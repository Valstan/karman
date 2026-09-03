import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth/current-user';
import {
  addDocumentFile,
  countDocumentFiles,
  getDocumentOwnerId,
} from '@/lib/services/documents';
import { saveDocumentFile, deleteFileByRelPath } from '@/lib/storage/media';
import { MAX_FILES_PER_DOCUMENT, sanitizeFileName } from '@/lib/storage/media-paths';

// Файловый ввод-вывод требует Node runtime.
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

const VALIDATION_MESSAGE: Record<string, string> = {
  type: 'Поддерживаются только JPG, PNG, WEBP или PDF',
  size: 'Файл больше 10 МБ',
  empty: 'Пустой файл',
};

/**
 * Добавляет ОДИН файл к документу. Форма шлёт файлы по одному, а не пачкой:
 * иначе частичный отказ (пятый файл превысил лимит) оставлял бы вызывающего
 * без ответа на вопрос «какие четыре доехали».
 */
export async function POST(req: Request, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ message: 'Требуется авторизация' }, { status: 401 });

  const { id: rawId } = await ctx.params;
  const docId = Number(rawId);
  if (!Number.isInteger(docId) || docId <= 0) {
    return NextResponse.json({ message: 'Некорректный запрос' }, { status: 400 });
  }

  // Владелец нужен и для проверки доступа, и для пути на диске: файлы лежат
  // под id ВЛАДЕЛЬЦА, поэтому удаление каталога документа находит их всегда.
  const ownerId = await getDocumentOwnerId(user, docId);
  if (ownerId === null) {
    return NextResponse.json({ message: 'Документ не найден' }, { status: 404 });
  }

  if ((await countDocumentFiles(docId)) >= MAX_FILES_PER_DOCUMENT) {
    return NextResponse.json(
      { message: `Больше ${MAX_FILES_PER_DOCUMENT} файлов на документ нельзя` },
      { status: 400 },
    );
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ message: 'Файл не передан' }, { status: 400 });
  }

  let relPath: string;
  try {
    relPath = await saveDocumentFile(ownerId, docId, file);
  } catch (e) {
    const code = e instanceof Error ? e.message : 'type';
    return NextResponse.json(
      { message: VALIDATION_MESSAGE[code] ?? 'Не удалось сохранить файл' },
      { status: 400 },
    );
  }

  try {
    const fileId = await addDocumentFile(docId, {
      path: relPath,
      originalName: sanitizeFileName(file.name).slice(0, 255),
      mime: file.type.slice(0, 100),
      sizeBytes: file.size,
    });
    revalidatePath('/', 'layout');
    return NextResponse.json({ ok: true, id: fileId });
  } catch (e) {
    // Запись в БД не удалась (например, документ удалили между проверками) —
    // файл на диске остаётся сиротой, поэтому убираем его сразу. Иначе media/
    // копит файлы, на которые никто не ссылается, и вычистить их потом нечем.
    await deleteFileByRelPath(relPath);
    throw e;
  }
}
