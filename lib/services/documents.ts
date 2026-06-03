import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { documentsDocument } from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import type { DocumentCreateInput, DocumentUpdateInput } from '@/lib/validation/document';

/**
 * documents_document.category_id — NOT NULL FK на documents_documentcategory.
 * Категории документов пока НЕ моделируются в новом UI; до появления выбора
 * категории все новые документы пишутся в «Прочее» (id=8 в боевой БД).
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
};

export async function listDocuments(user: SessionUser): Promise<DocumentListItem[]> {
  return db
    .select({
      id: documentsDocument.id,
      title: documentsDocument.title,
      documentType: documentsDocument.documentType,
      documentNumber: documentsDocument.documentNumber,
      issueDate: documentsDocument.issueDate,
      expiryDate: documentsDocument.expiryDate,
      issuingAuthority: documentsDocument.issuingAuthority,
      isActive: documentsDocument.isActive,
    })
    .from(documentsDocument)
    .where(ownership(user, documentsDocument.userId))
    .orderBy(desc(documentsDocument.id));
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
      categoryId: DEFAULT_DOCUMENT_CATEGORY_ID,
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
    .returning({ id: documentsDocument.id });
  return result.length > 0;
}
