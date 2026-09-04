import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Pencil, Share2, Users } from 'lucide-react';
import { requireUser } from '@/lib/auth/current-user';
import { getDocumentDetail, listDocumentCategories } from '@/lib/services/documents';
import { getOwnProfile } from '@/lib/services/profile';
import { displayName } from '@/lib/profile/fields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DocumentFormDialog } from '@/components/app/document-form-dialog';
import { DocumentFieldsPanel } from '@/components/app/document-fields-panel';
import { DocumentFilesPanel } from '@/components/app/document-files-panel';
import { DocumentShareDialog } from '@/components/app/documents-table';
import { CircleShareToggle } from '@/components/app/circle-share-toggle';

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

  const [document, categories, profile] = await Promise.all([
    getDocumentDetail(user, id),
    listDocumentCategories(),
    getOwnProfile(user),
  ]);
  // Чужой документ и несуществующий отдают ОДИН И ТОТ ЖЕ ответ: иначе разница
  // между 404 и 403 сама по себе сообщает, что документ с таким id есть.
  if (!document) notFound();

  const today = new Date().toISOString().slice(0, 10);
  const me = { userId: user.id, name: displayName(profile, user.username), profile };
  const exportDoc = {
    id: document.id,
    ownerUserId: user.id,
    title: document.title,
    documentType: document.documentType,
    documentNumber: document.documentNumber,
    issueDate: document.issueDate,
    expiryDate: document.expiryDate,
    issuingAuthority: document.issuingAuthority,
    fields: document.fields.map((f) => ({ name: f.name, value: f.value })),
    files: document.files.map((f) => ({ id: f.id, originalName: f.originalName, isImage: f.isImage })),
  };
  const hasCore =
    document.documentNumber !== '' ||
    document.issueDate !== null ||
    document.expiryDate !== null ||
    document.issuingAuthority !== '';

  return (
    <div className="flex flex-col gap-6">
      <div className="no-print">
        <Link
          href="/documents"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> К списку
        </Link>
      </div>

      <div className="no-print flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{document.title}</h1>
          <Badge variant={document.isActive ? 'default' : 'secondary'}>
            {document.isActive ? 'Действует' : 'Недействителен'}
          </Badge>
          {document.circleSharedAt && (
            <Badge variant="outline" title="Виден участникам круга">
              <Users className="mr-1 h-3 w-3" /> В круге
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <CircleShareToggle documentId={document.id} shared={document.circleSharedAt !== null} />
          <DocumentShareDialog
            me={me}
            document={exportDoc}
            today={today}
            trigger={
              <Button variant="outline">
                <Share2 className="mr-1 h-4 w-4" /> Поделиться
              </Button>
            }
          />
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
      </div>

      {hasCore && (
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
      )}

      <DocumentFieldsPanel documentId={document.id} fields={document.fields} />
      <DocumentFilesPanel documentId={document.id} files={document.files} />
    </div>
  );
}
