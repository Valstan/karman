import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Pencil } from 'lucide-react';
import { requireUser } from '@/lib/auth/current-user';
import { getDocumentDetail, listDocumentCategories } from '@/lib/services/documents';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DocumentFormDialog } from '@/components/app/document-form-dialog';
import { DocumentFieldsPanel } from '@/components/app/document-fields-panel';
import { DocumentFilesPanel } from '@/components/app/document-files-panel';

/** Одна строка «подпись → значение» в шапке документа. */
function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value === '' ? '—' : value}</dd>
    </div>
  );
}

function formatDate(value: string | null): string {
  if (!value) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const [document, categories] = await Promise.all([
    getDocumentDetail(user, id),
    listDocumentCategories(),
  ]);
  // Чужой документ и несуществующий отдают ОДИН И ТОТ ЖЕ ответ: иначе разница
  // между 404 и 403 сама по себе сообщает, что документ с таким id есть.
  if (!document) notFound();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/documents"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> К списку
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{document.title}</h1>
          <Badge variant={document.isActive ? 'default' : 'secondary'}>
            {document.isActive ? 'Действует' : 'Недействителен'}
          </Badge>
        </div>
        <DocumentFormDialog
          document={document}
          categories={categories}
          trigger={
            <Button variant="outline">
              <Pencil className="mr-1 h-4 w-4" /> Изменить
            </Button>
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Основное</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Info label="Тип" value={document.documentType} />
            <Info label="Номер" value={document.documentNumber} />
            <Info label="Дата выдачи" value={formatDate(document.issueDate)} />
            <Info label="Действует до" value={formatDate(document.expiryDate)} />
            <Info label="Кем выдан" value={document.issuingAuthority} />
          </dl>
        </CardContent>
      </Card>

      <DocumentFieldsPanel documentId={document.id} fields={document.fields} />
      <DocumentFilesPanel documentId={document.id} files={document.files} />
    </div>
  );
}
