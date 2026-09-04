import { Download, Plus } from 'lucide-react';
import { requireUser } from '@/lib/auth/current-user';
import {
  listDocuments,
  listDocumentCategories,
  listOwnExportDocuments,
} from '@/lib/services/documents';
import { getOwnProfile } from '@/lib/services/profile';
import { displayName } from '@/lib/profile/fields';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DocumentFormDialog } from '@/components/app/document-form-dialog';
import { DocumentsTable } from '@/components/app/documents-table';
import { ProfileForm } from '@/components/app/profile-form';

/**
 * Единый раздел «Документы» (решение владельца 2026-09-04). Сверху — «Кто я»:
 * то, что не документ (ФИО, рождение). Ниже — документы по видам, каждый со
 * своими полями и файлами, галочки для «поделиться» и «в круг».
 *
 * Дата берётся на сервере и передаётся вниз: сборщик имени файла — чистый
 * модуль, часов в нём нет намеренно.
 */
export default async function DocumentsPage() {
  const user = await requireUser();
  const [documents, categories, exportDocuments, profile] = await Promise.all([
    listDocuments(user),
    listDocumentCategories(),
    listOwnExportDocuments(user),
    getOwnProfile(user),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const me = { userId: user.id, name: displayName(profile, user.username), profile };

  return (
    <div className="flex flex-col gap-6">
      <div className="no-print flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Документы</h1>
          <p className="text-sm text-muted-foreground">
            Паспорт, СНИЛС, ИНН, телефоны, образование — всё в одном месте. Видите их только вы,
            пока сами не отметите «В круг» или не поделитесь.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {documents.length > 0 && (
            <a href="/api/export/documents" className={buttonVariants({ variant: 'outline' })}>
              <Download className="mr-1 h-4 w-4" /> CSV
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

      <Card className="no-print">
        <CardHeader>
          <CardTitle className="text-base">Кто я</CardTitle>
          <CardDescription>
            ФИО и рождение — под этим именем вас видит круг. Остальные реквизиты — документами ниже.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <details open={me.name === user.username}>
            <summary className="cursor-pointer text-sm font-medium">{me.name}</summary>
            <div className="mt-4">
              <ProfileForm profile={profile} />
            </div>
          </details>
        </CardContent>
      </Card>

      <DocumentsTable
        documents={documents}
        categories={categories}
        exportDocuments={exportDocuments}
        me={me}
        today={today}
      />
    </div>
  );
}
