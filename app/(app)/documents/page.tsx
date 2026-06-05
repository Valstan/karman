import { Download, Plus } from 'lucide-react';
import { requireUser } from '@/lib/auth/current-user';
import { listDocuments, listDocumentCategories } from '@/lib/services/documents';
import { Button, buttonVariants } from '@/components/ui/button';
import { DocumentFormDialog } from '@/components/app/document-form-dialog';
import { DocumentsTable } from '@/components/app/documents-table';

export default async function DocumentsPage() {
  const user = await requireUser();
  const [documents, categories] = await Promise.all([
    listDocuments(user),
    listDocumentCategories(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Документы</h1>
        <div className="flex items-center gap-2">
          {documents.length > 0 && (
            <a href="/api/export/documents" className={buttonVariants({ variant: 'outline' })}>
              <Download className="mr-1 h-4 w-4" /> Экспорт CSV
            </a>
          )}
          <DocumentFormDialog
            categories={categories}
            trigger={
              <Button>
                <Plus className="mr-1 h-4 w-4" /> Новый документ
              </Button>
            }
          />
        </div>
      </div>
      <DocumentsTable documents={documents} categories={categories} />
    </div>
  );
}
