import 'server-only';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  documentField,
  documentFile,
  documentsDocument,
  documentsDocumentcategory,
} from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import type { DocumentCreateInput, DocumentUpdateInput } from '@/lib/validation/document';
import { isImagePath } from '@/lib/storage/media-paths';
import { deleteDocumentDir } from '@/lib/storage/media';

/**
 * documents_document.category_id — NOT NULL FK на documents_documentcategory.
 * Категория выбирается в форме; «Прочее» (id=8 в боевой БД) — только запасной
 * вариант, если форма по какой-то причине не прислала категорию.
 */
const DEFAULT_DOCUMENT_CATEGORY_ID = 8;

export type DocumentListItem = {
  id: number;
  title: string;
  documentType: string;
  documentNumber: string;
  issueDate: string | null;
  expiryDate: string | null;
  issuingAuthority: string | null;
  isActive: boolean;
  categoryId: number;
  categoryName: string | null;
  /** Открыт кругу галочкой «В круг»; null — виден только мне. */
  circleSharedAt: string | null;
  /** Сколько файлов прикреплено (0 — ни одного). */
  fileCount: number;
  /**
   * id первого файла-картинки — для миниатюры в списке. Путь наружу не отдаётся
   * никогда: файл доступен только через авторизованный роут по id.
   */
  previewFileId: number | null;
};

/** Поле документа: пара «название → значение», заданная человеком. */
export type DocumentFieldItem = {
  id: number;
  name: string;
  value: string;
};

/** Файл документа в том виде, в каком его видит интерфейс (без пути на диске). */
export type DocumentFileItem = {
  id: number;
  originalName: string;
  mime: string;
  sizeBytes: number;
  isImage: boolean;
};

/** Документ целиком — для экрана карточки. */
export type DocumentDetail = {
  id: number;
  title: string;
  description: string;
  documentType: string;
  documentNumber: string;
  issueDate: string | null;
  expiryDate: string | null;
  issuingAuthority: string;
  isActive: boolean;
  categoryId: number;
  circleSharedAt: string | null;
  fields: DocumentFieldItem[];
  files: DocumentFileItem[];
};

export type DocumentCategoryOption = {
  id: number;
  name: string;
};

export async function listDocumentCategories(): Promise<DocumentCategoryOption[]> {
  return db
    .select({ id: documentsDocumentcategory.id, name: documentsDocumentcategory.name })
    .from(documentsDocumentcategory)
    .orderBy(documentsDocumentcategory.name);
}

export async function listDocuments(user: SessionUser): Promise<DocumentListItem[]> {
  const rows = await db
    .select({
      id: documentsDocument.id,
      title: documentsDocument.title,
      documentType: documentsDocument.documentType,
      documentNumber: documentsDocument.documentNumber,
      issueDate: documentsDocument.issueDate,
      expiryDate: documentsDocument.expiryDate,
      issuingAuthority: documentsDocument.issuingAuthority,
      isActive: documentsDocument.isActive,
      categoryId: documentsDocument.categoryId,
      categoryName: documentsDocumentcategory.name,
      circleSharedAt: documentsDocument.circleSharedAt,
    })
    .from(documentsDocument)
    .leftJoin(
      documentsDocumentcategory,
      eq(documentsDocument.categoryId, documentsDocumentcategory.id),
    )
    .where(ownership(user, documentsDocument.userId))
    .orderBy(desc(documentsDocument.id));

  if (rows.length === 0) return [];

  // Файлы забираются одним запросом по списку документов, а не подзапросом на
  // строку: документов у человека десятки, и вторая выборка дешевле, чем
  // коррелированный подзапрос, который вдобавок пришлось бы писать дважды —
  // для счётчика и для превью.
  const files = await db
    .select({
      documentId: documentFile.documentId,
      id: documentFile.id,
      path: documentFile.path,
    })
    .from(documentFile)
    .where(
      inArray(
        documentFile.documentId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(documentFile.position), asc(documentFile.id));

  const counts = new Map<number, number>();
  const previews = new Map<number, number>();
  for (const file of files) {
    counts.set(file.documentId, (counts.get(file.documentId) ?? 0) + 1);
    // Превью — ПЕРВАЯ картинка, а не первый файл: если документ начинается с
    // PDF, миниатюра всё равно должна найтись дальше по списку.
    if (!previews.has(file.documentId) && isImagePath(file.path)) {
      previews.set(file.documentId, file.id);
    }
  }

  // Пути наружу не отдаются — только количество и id для превью; сам файл
  // достаётся авторизованным роутом /api/documents/[id]/files/[fileId].
  return rows.map((row) => ({
    ...row,
    fileCount: counts.get(row.id) ?? 0,
    previewFileId: previews.get(row.id) ?? null,
  }));
}

/** Документ целиком со своими полями и файлами. null — нет или чужой. */
export async function getDocumentDetail(
  user: SessionUser,
  id: number,
): Promise<DocumentDetail | null> {
  const [row] = await db
    .select()
    .from(documentsDocument)
    .where(and(eq(documentsDocument.id, id), ownership(user, documentsDocument.userId)))
    .limit(1);
  if (!row) return null;

  const [fields, files] = await Promise.all([
    db
      .select({ id: documentField.id, name: documentField.name, value: documentField.value })
      .from(documentField)
      .where(eq(documentField.documentId, id))
      .orderBy(asc(documentField.position), asc(documentField.id)),
    db
      .select()
      .from(documentFile)
      .where(eq(documentFile.documentId, id))
      .orderBy(asc(documentFile.position), asc(documentFile.id)),
  ]);

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    documentType: row.documentType,
    documentNumber: row.documentNumber,
    issueDate: row.issueDate,
    expiryDate: row.expiryDate,
    issuingAuthority: row.issuingAuthority,
    isActive: row.isActive,
    categoryId: row.categoryId,
    circleSharedAt: row.circleSharedAt,
    fields,
    files: files.map((f) => ({
      id: f.id,
      originalName: f.originalName,
      mime: f.mime,
      sizeBytes: f.sizeBytes,
      isImage: isImagePath(f.path),
    })),
  };
}

/**
 * Заменяет НАБОР полей документа целиком: удалить всё и вставить присланное.
 * Не diff по id намеренно — форма позволяет переименовать, переставить и
 * удалить поля разом, и «умное» сопоставление старых строк с новыми здесь
 * было бы догадкой. Строки полей не адресуются снаружи и не участвуют в
 * ссылках, поэтому их пересоздание ничего не рвёт.
 *
 * false — документа нет или он чужой.
 */
export async function replaceDocumentFields(
  user: SessionUser,
  id: number,
  fields: { name: string; value: string }[],
): Promise<boolean> {
  const ownerId = await getDocumentOwnerId(user, id);
  if (ownerId === null) return false;

  await db.transaction(async (tx) => {
    await tx.delete(documentField).where(eq(documentField.documentId, id));
    if (fields.length > 0) {
      await tx.insert(documentField).values(
        fields.map((f, index) => ({
          documentId: id,
          name: f.name,
          value: f.value,
          position: index,
        })),
      );
    }
    await tx
      .update(documentsDocument)
      .set({ updatedAt: sql`NOW()` })
      .where(eq(documentsDocument.id, id));
  });
  return true;
}

/** Путь файла на диске по его id, с проверкой владельца документа. */
export async function getDocumentFilePathById(
  user: SessionUser,
  docId: number,
  fileId: number,
): Promise<string | null> {
  const [row] = await db
    .select({ path: documentFile.path })
    .from(documentFile)
    .innerJoin(documentsDocument, eq(documentsDocument.id, documentFile.documentId))
    .where(
      and(
        eq(documentFile.id, fileId),
        // Оба условия обязательны: без сверки documentId ссылка вида
        // /documents/<свой>/files/<чужой файл> прошла бы проверку владения по
        // СВОЕМУ документу, а отдала бы чужой файл.
        eq(documentFile.documentId, docId),
        ownership(user, documentsDocument.userId),
      ),
    )
    .limit(1);
  return row?.path ?? null;
}

/** Сколько файлов уже прикреплено (для лимита). */
export async function countDocumentFiles(docId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(documentFile)
    .where(eq(documentFile.documentId, docId));
  return row?.n ?? 0;
}

/** Регистрирует уже сохранённый на диск файл. Возвращает id записи. */
export async function addDocumentFile(
  docId: number,
  file: { path: string; originalName: string; mime: string; sizeBytes: number },
): Promise<number> {
  const position = await countDocumentFiles(docId);
  const [created] = await db
    .insert(documentFile)
    .values({ documentId: docId, position, ...file })
    .returning({ id: documentFile.id });
  return created!.id;
}

/**
 * Удаляет запись файла и возвращает его путь, чтобы вызывающий снёс файл с
 * диска. null — файла нет или документ чужой.
 */
export async function deleteDocumentFileById(
  user: SessionUser,
  docId: number,
  fileId: number,
): Promise<string | null> {
  const relPath = await getDocumentFilePathById(user, docId, fileId);
  if (relPath === null) return null;
  await db.delete(documentFile).where(eq(documentFile.id, fileId));
  return relPath;
}

/**
 * userId владельца документа (с проверкой доступа). null — документа нет или он
 * не принадлежит пользователю. Нужен, чтобы складывать файлы под id владельца —
 * тогда `deleteDocumentDir` чистит их при удалении даже для superuser.
 */
export async function getDocumentOwnerId(user: SessionUser, id: number): Promise<number | null> {
  const [row] = await db
    .select({ userId: documentsDocument.userId })
    .from(documentsDocument)
    .where(and(eq(documentsDocument.id, id), ownership(user, documentsDocument.userId)))
    .limit(1);
  return row?.userId ?? null;
}

export async function createDocument(user: SessionUser, input: DocumentCreateInput): Promise<number> {
  const [created] = await db
    .insert(documentsDocument)
    .values({
      title: input.title,
      description: input.description ?? '',
      documentType: input.documentType ?? '',
      documentNumber: input.documentNumber ?? '',
      issueDate: input.issueDate ?? null,
      expiryDate: input.expiryDate ?? null,
      issuingAuthority: input.issuingAuthority ?? '',
      isActive: input.isActive ?? true,
      userId: user.id,
      categoryId: input.categoryId ?? DEFAULT_DOCUMENT_CATEGORY_ID,
    })
    .returning({ id: documentsDocument.id });
  return created!.id;
}

export async function updateDocument(user: SessionUser, input: DocumentUpdateInput): Promise<boolean> {
  const { id, ...fields } = input;
  const patch: Record<string, unknown> = {};
  if (fields.title !== undefined) patch.title = fields.title;
  if (fields.description !== undefined) patch.description = fields.description ?? '';
  if (fields.documentType !== undefined) patch.documentType = fields.documentType ?? '';
  if (fields.documentNumber !== undefined) patch.documentNumber = fields.documentNumber ?? '';
  if (fields.issueDate !== undefined) patch.issueDate = fields.issueDate ?? null;
  if (fields.expiryDate !== undefined) patch.expiryDate = fields.expiryDate ?? null;
  if (fields.issuingAuthority !== undefined) patch.issuingAuthority = fields.issuingAuthority ?? '';
  if (fields.isActive !== undefined) patch.isActive = fields.isActive;
  if (fields.categoryId !== undefined) patch.categoryId = fields.categoryId;

  if (Object.keys(patch).length === 0) {
    return false;
  }
  patch.updatedAt = sql`NOW()`;

  const result = await db
    .update(documentsDocument)
    .set(patch)
    .where(and(eq(documentsDocument.id, id), ownership(user, documentsDocument.userId)))
    .returning({ id: documentsDocument.id });
  return result.length > 0;
}

export async function deleteDocument(user: SessionUser, id: number): Promise<boolean> {
  const result = await db
    .delete(documentsDocument)
    .where(and(eq(documentsDocument.id, id), ownership(user, documentsDocument.userId)))
    .returning({ id: documentsDocument.id, userId: documentsDocument.userId });
  const deleted = result[0];
  if (!deleted) return false;
  // Сносим каталог со сканами документа (best-effort, не блокирует ответ).
  await deleteDocumentDir(deleted.userId, deleted.id);
  return true;
}

/**
 * Открыть кругу или забрать из круга — СВОИ документы, списком. Возвращает,
 * сколько строк реально поменяно: чужие id молча выпадают из WHERE, а не
 * дают ошибку — иначе ответ сообщал бы, что документ с таким id существует.
 */
export async function setCircleShared(
  user: SessionUser,
  ids: number[],
  shared: boolean,
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(documentsDocument)
    .set({ circleSharedAt: shared ? sql`NOW()` : null, updatedAt: sql`NOW()` })
    .where(and(inArray(documentsDocument.id, ids), ownership(user, documentsDocument.userId)))
    .returning({ id: documentsDocument.id });
  return rows.length;
}

/** Документ в форме выгрузки — та же, что у документов круга (`composeExport`). */
export type OwnExportDocument = {
  id: number;
  ownerUserId: number;
  title: string;
  documentType: string;
  documentNumber: string;
  issueDate: string | null;
  expiryDate: string | null;
  issuingAuthority: string;
  fields: { name: string; value: string }[];
  files: { id: number; originalName: string; isImage: boolean }[];
};

/**
 * Свои документы целиком — с полями и файлами — для «поделиться» прямо из
 * раздела «Документы». Отдельно от списка: списку поля не нужны, а выгрузке
 * нужны все, и тащить их в каждую отрисовку таблицы незачем.
 */
export async function listOwnExportDocuments(user: SessionUser): Promise<OwnExportDocument[]> {
  const docs = await db
    .select({
      id: documentsDocument.id,
      ownerUserId: documentsDocument.userId,
      title: documentsDocument.title,
      documentType: documentsDocument.documentType,
      documentNumber: documentsDocument.documentNumber,
      issueDate: documentsDocument.issueDate,
      expiryDate: documentsDocument.expiryDate,
      issuingAuthority: documentsDocument.issuingAuthority,
    })
    .from(documentsDocument)
    .where(ownership(user, documentsDocument.userId))
    .orderBy(desc(documentsDocument.id));
  if (docs.length === 0) return [];
  const docIds = docs.map((d) => d.id);

  const [fields, files] = await Promise.all([
    db
      .select({ documentId: documentField.documentId, name: documentField.name, value: documentField.value })
      .from(documentField)
      .where(inArray(documentField.documentId, docIds))
      .orderBy(asc(documentField.position), asc(documentField.id)),
    db
      .select({
        documentId: documentFile.documentId,
        id: documentFile.id,
        originalName: documentFile.originalName,
        path: documentFile.path,
      })
      .from(documentFile)
      .where(inArray(documentFile.documentId, docIds))
      .orderBy(asc(documentFile.position), asc(documentFile.id)),
  ]);

  const fieldsByDoc = new Map<number, { name: string; value: string }[]>();
  for (const f of fields) {
    const list = fieldsByDoc.get(f.documentId) ?? [];
    list.push({ name: f.name, value: f.value });
    fieldsByDoc.set(f.documentId, list);
  }
  const filesByDoc = new Map<number, { id: number; originalName: string; isImage: boolean }[]>();
  for (const f of files) {
    const list = filesByDoc.get(f.documentId) ?? [];
    list.push({ id: f.id, originalName: f.originalName, isImage: isImagePath(f.path) });
    filesByDoc.set(f.documentId, list);
  }
  return docs.map((d) => ({
    ...d,
    fields: fieldsByDoc.get(d.id) ?? [],
    files: filesByDoc.get(d.id) ?? [],
  }));
}
