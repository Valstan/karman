import { Plus } from 'lucide-react';
import { requireUser } from '@/lib/auth/current-user';
import { listDocuments } from '@/lib/services/documents';
import { Button } from '@/components/ui/button';
import { DocumentFormDialog } from '@/components/app/document-form-dialog';
import { DocumentsTable } from '@/components/app/documents-table';

export default async function DocumentsPage() {
  const user = await requireUser();
  const documents = await listDocuments(user);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Документы</h1>
        <DocumentFormDialog
          trigger={
            <Button>
              <Plus className="mr-1 h-4 w-4" /> Новый документ
            </Button>
          }
        />
      </div>
      <DocumentsTable documents={documents} />
    </div>
  );
}
