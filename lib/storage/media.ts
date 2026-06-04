import 'server-only';
import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  absolutePathFor,
  buildRelPath,
  extForMime,
  MAX_FILE_BYTES,
  type DocumentFileSlot,
  type FileValidationError,
} from './media-paths';

export * from './media-paths';

/**
 * Сохраняет файл на диск, возвращает относительный путь для записи в БД.
 * Бросает Error со строковым кодом валидации ('type' | 'size' | 'empty').
 */
export async function saveDocumentFile(
  userId: number,
  docId: number,
  slot: DocumentFileSlot,
  file: File,
): Promise<string> {
  if (!file || file.size === 0) throw new Error('empty' satisfies FileValidationError);
  if (file.size > MAX_FILE_BYTES) throw new Error('size' satisfies FileValidationError);
  const ext = extForMime(file.type);
  if (!ext) throw new Error('type' satisfies FileValidationError);

  const token = randomBytes(4).toString('hex');
  const relPath = buildRelPath(userId, docId, slot, ext, token);
  const abs = absolutePathFor(relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(abs, buffer);
  return relPath;
}

/** Тихо удаляет файл по относительному пути (если он есть). */
export async function deleteFileByRelPath(relPath: string | null | undefined): Promise<void> {
  if (!relPath) return;
  try {
    await rm(absolutePathFor(relPath), { force: true });
  } catch {
    // файла может не быть — это не ошибка
  }
}

/** Удаляет весь каталог документа (при удалении самого документа). */
export async function deleteDocumentDir(userId: number, docId: number): Promise<void> {
  try {
    const abs = absolutePathFor(path.posix.join('documents', String(userId), String(docId)));
    await rm(abs, { recursive: true, force: true });
  } catch {
    // каталога может не быть
  }
}

/** Проверяет существование файла (для отдачи 404 без чтения). */
export async function fileExists(relPath: string): Promise<boolean> {
  try {
    const s = await stat(absolutePathFor(relPath));
    return s.isFile();
  } catch {
    return false;
  }
}
