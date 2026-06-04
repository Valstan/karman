'use client';

import { useRouter } from 'next/navigation';
import { Pencil, Trash2, Image as ImageIcon, Paperclip } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DocumentFormDialog } from './document-form-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { deleteDocumentAction } from '@/lib/actions/documents';
import { documentExpiryBadge } from '@/lib/constants';
import { formatDate } from '@/lib/format';
import type { DocumentListItem, DocumentCategoryOption } from '@/lib/services/documents';

export function DocumentsTable({
  documents,
  categories,
}: {
  documents: DocumentListItem[];
  categories: DocumentCategoryOption[];
}) {
  const router = useRouter();

  async function remove(id: number) {
    const result = await deleteDocumentAction(id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Документ удалён');
    router.refresh();
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Название</TableHead>
            <TableHead>Категория</TableHead>
            <TableHead>Тип</TableHead>
            <TableHead>Номер</TableHead>
            <TableHead>Выдан</TableHead>
            <TableHead>Действует до</TableHead>
            <TableHead>Сканы</TableHead>
            <TableHead>Статус</TableHead>
            <TableHead className="text-right">Действия</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.length === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
                Документов пока нет.
              </TableCell>
            </TableRow>
          )}
          {documents.map((doc) => (
            <TableRow key={doc.id}>
              <TableCell className="font-medium">{doc.title}</TableCell>
              <TableCell>{doc.categoryName || '—'}</TableCell>
              <TableCell>{doc.documentType || '—'}</TableCell>
              <TableCell>{doc.documentNumber || '—'}</TableCell>
              <TableCell>{formatDate(doc.issueDate)}</TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <span>{formatDate(doc.expiryDate)}</span>
                  {(() => {
                    const badge = documentExpiryBadge(doc.expiryDate);
                    return badge ? (
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    ) : null;
                  })()}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  {doc.hasFront && (
                    <a
                      href={`/api/documents/${doc.id}/file/front`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Лицевая сторона"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <ImageIcon className="h-4 w-4" />
                    </a>
                  )}
                  {doc.hasBack && (
                    <a
                      href={`/api/documents/${doc.id}/file/back`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Оборотная сторона"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <ImageIcon className="h-4 w-4" />
                    </a>
                  )}
                  {doc.hasAdditional && (
                    <a
                      href={`/api/documents/${doc.id}/file/additional`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Доп. файл"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Paperclip className="h-4 w-4" />
                    </a>
                  )}
                  {!doc.hasFront && !doc.hasBack && !doc.hasAdditional && (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <Badge variant={doc.isActive ? 'default' : 'secondary'}>
                  {doc.isActive ? 'Действует' : 'Недействителен'}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  <DocumentFormDialog
                    document={doc}
                    categories={categories}
                    trigger={
                      <Button size="icon" variant="ghost" title="Редактировать">
                        <Pencil className="h-4 w-4" />
                      </Button>
                    }
                  />
                  <ConfirmDialog
                    title="Удалить документ?"
                    description="Действие необратимо."
                    onConfirm={() => remove(doc.id)}
                    trigger={
                      <Button size="icon" variant="ghost" title="Удалить">
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    }
                  />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
