import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { documentsDocument, documentsDocumentcategory } from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import type { DocumentCreateInput, DocumentUpdateInput } from '@/lib/validation/document';
import { SLOT_TO_COLUMN, isImagePath, type DocumentFileSlot } from '@/lib/storage/media-paths';
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
  hasFront: boolean;
  hasBack: boolean;
  hasAdditional: boolean;
  // Картинка ли файл в слоте (для миниатюры). PDF → false, показываем иконку.
  frontIsImage: boolean;
  backIsImage: boolean;
  additionalIsImage: boolean;
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
      frontImage: documentsDocument.frontImage,
      backImage: documentsDocument.backImage,
      additionalFiles: documentsDocument.additionalFiles,
    })
    .from(documentsDocument)
    .leftJoin(
      documentsDocumentcategory,
      eq(documentsDocument.categoryId, documentsDocumentcategory.id),
    )
    .where(ownership(user, documentsDocument.userId))
    .orderBy(desc(documentsDocument.id));

  // Пути файлов не отдаём клиенту — только флаги наличия (доступ к самим
  // файлам идёт через авторизованный /api/documents/[id]/file/[slot]).
  return rows.map(({ frontImage, backImage, additionalFiles, ...rest }) => ({
    ...rest,
    hasFront: Boolean(frontImage),
    hasBack: Boolean(backImage),
    hasAdditional: Boolean(additionalFiles),
    frontIsImage: frontImage ? isImagePath(frontImage) : false,
    backIsImage: backImage ? isImagePath(backImage) : false,
    additionalIsImage: additionalFiles ? isImagePath(additionalFiles) : false,
  }));
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

/**
 * Относительный путь файла слота с проверкой владельца. null — документа нет,
 * не принадлежит пользователю или файл в слоте не загружен.
 */
export async function getDocumentFilePath(
  user: SessionUser,
  id: number,
  slot: DocumentFileSlot,
): Promise<string | null> {
  const column = SLOT_TO_COLUMN[slot];
  const [row] = await db
    .select({
      frontImage: documentsDocument.frontImage,
      backImage: documentsDocument.backImage,
      additionalFiles: documentsDocument.additionalFiles,
    })
    .from(documentsDocument)
    .where(and(eq(documentsDocument.id, id), ownership(user, documentsDocument.userId)))
    .limit(1);
  if (!row) return null;
  return row[column] ?? null;
}

/**
 * Записывает относительный путь файла в колонку слота (или null при удалении)
 * с проверкой владельца. Возвращает предыдущий путь (для удаления старого файла)
 * либо undefined, если документ не найден/не принадлежит пользователю.
 */
export async function setDocumentFilePath(
  user: SessionUser,
  id: number,
  slot: DocumentFileSlot,
  relPath: string | null,
): Promise<string | null | undefined> {
  const column = SLOT_TO_COLUMN[slot];
  const previous = await getDocumentFilePath(user, id, slot);
  if (previous === null) {
    // отличаем «нет такого документа» от «слот пуст»
    const [exists] = await db
      .select({ id: documentsDocument.id })
      .from(documentsDocument)
      .where(and(eq(documentsDocument.id, id), ownership(user, documentsDocument.userId)))
      .limit(1);
    if (!exists) return undefined;
  }
  await db
    .update(documentsDocument)
    .set({ [column]: relPath, updatedAt: sql`NOW()` })
    .where(and(eq(documentsDocument.id, id), ownership(user, documentsDocument.userId)));
  return previous;
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
