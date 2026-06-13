import path from 'node:path';

/**
 * Чистые помощники для путей/типов сканов документов — без файловой системы и
 * без `server-only`, поэтому модуль тестируется юнит-тестами и переиспользуется
 * сервером (`media.ts`).
 *
 * В БД (varchar(100)) хранится ОТНОСИТЕЛЬНЫЙ путь вида
 * `documents/<userId>/<docId>/<slot>-<token>.<ext>`.
 */

export const DOCUMENT_FILE_SLOTS = ['front', 'back', 'additional'] as const;
export type DocumentFileSlot = (typeof DOCUMENT_FILE_SLOTS)[number];

/** Колонка БД для каждого слота. */
export const SLOT_TO_COLUMN: Record<DocumentFileSlot, 'frontImage' | 'backImage' | 'additionalFiles'> = {
  front: 'frontImage',
  back: 'backImage',
  additional: 'additionalFiles',
};

export function isDocumentFileSlot(value: string): value is DocumentFileSlot {
  return (DOCUMENT_FILE_SLOTS as readonly string[]).includes(value);
}

/** Максимальный размер файла (10 МБ). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export type FileValidationError = 'type' | 'size' | 'empty';

/** Расширение по mime или null, если тип не разрешён. */
export function extForMime(mime: string): string | null {
  return MIME_TO_EXT[mime] ?? null;
}

/** Абсолютный корень хранилища (MEDIA_ROOT или `<cwd>/media`). */
export function mediaRoot(): string {
  const configured = process.env.MEDIA_ROOT?.trim();
  return configured && configured.length > 0
    ? path.resolve(configured)
    : path.join(process.cwd(), 'media');
}

/** Абсолютный путь по относительному (с защитой от выхода за MEDIA_ROOT). */
export function absolutePathFor(relPath: string): string {
  const root = mediaRoot();
  const abs = path.resolve(root, relPath);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Недопустимый путь к файлу');
  }
  return abs;
}

/**
 * Относительный путь для нового файла. token — случайный, чтобы старая ссылка
 * становилась невалидной после замены и не было коллизий.
 */
export function buildRelPath(
  userId: number,
  docId: number,
  slot: DocumentFileSlot,
  ext: string,
  token: string,
): string {
  return path.posix.join('documents', String(userId), String(docId), `${slot}-${token}.${ext}`);
}

/** content-type для отдачи по расширению относительного пути. */
export function contentTypeForPath(relPath: string): string {
  const ext = path.extname(relPath).slice(1).toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}
