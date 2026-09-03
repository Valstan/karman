import path from 'node:path';

/**
 * Чистые помощники для путей/типов файлов документов — без файловой системы и
 * без `server-only`, поэтому модуль тестируется юнит-тестами и переиспользуется
 * сервером (`media.ts`).
 *
 * В БД (`document_file.path`, varchar(255)) хранится ОТНОСИТЕЛЬНЫЙ путь вида
 * `documents/<userId>/<docId>/<token>.<ext>`. До 2026-09-04 в имени был ещё и
 * слот (`front-…`), но слотов больше нет: файлов на документе много.
 */

/** Максимальный размер файла (10 МБ). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Сколько файлов разрешено на один документ. */
export const MAX_FILES_PER_DOCUMENT = 20;

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export type FileValidationError = 'type' | 'size' | 'empty' | 'too_many';

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
 * Относительный путь для нового файла. Имя — только случайный token: слот из
 * имени исчез вместе со слотами. Случайность нужна не для красоты, а чтобы два
 * файла с одинаковым исходным именем, загруженные подряд, не совпали, и чтобы
 * ссылка на удалённый файл не попадала во вновь загруженный.
 */
export function buildRelPath(userId: number, docId: number, ext: string, token: string): string {
  return path.posix.join('documents', String(userId), String(docId), `${token}.${ext}`);
}

/**
 * Чистит имя файла: убирает разделители пути и символы, запрещённые в именах
 * файлов, схлопывает многоточия и снимает ведущие точки. Имя приходит от
 * человека и попадает в имя записи ZIP-архива, где `../` уводит распаковку за
 * пределы каталога (zip-slip), а ведущая точка прячет файл.
 *
 * Пробелы и дефисы НЕ трогаются: «паспорт разворот 2.jpg» обязан остаться
 * читаемым — ради того имя и хранится отдельно от пути на диске.
 */
export function sanitizeFileName(value: string): string {
  const withoutSeparators = value.replace(/[/\\]/g, '');
  const withoutIllegal = withoutSeparators.replace(/[:*?"<>|]/g, '');
  return withoutIllegal
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .trim();
}

/**
 * Имя файла для выгрузки: то, под которым файл принесли, а если оно потеряно
 * или непригодно — осмысленная замена из названия документа и номера страницы.
 */
export function safeDownloadName(
  originalName: string,
  fallbackBase: string,
  index: number,
  relPath: string,
): string {
  const ext = path.extname(relPath).slice(1).toLowerCase() || 'bin';
  const cleaned = sanitizeFileName(originalName);
  if (cleaned !== '' && cleaned.length <= 120) return cleaned;
  const base = sanitizeFileName(fallbackBase) || 'документ';
  return `${base}-${index + 1}.${ext}`;
}

/** true, если файл — растровое изображение (можно показать миниатюрой). PDF → false. */
export function isImagePath(relPath: string): boolean {
  const ext = path.extname(relPath).slice(1).toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'webp';
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
