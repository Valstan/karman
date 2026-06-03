'use client';

import { useRouter } from 'next/navigation';
import { Pencil, Trash2 } from 'lucide-react';
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
import { formatDate } from '@/lib/format';
import type { DocumentListItem } from '@/lib/services/documents';

export function DocumentsTable({ documents }: { documents: DocumentListItem[] }) {
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
            <TableHead>Тип</TableHead>
            <TableHead>Номер</TableHead>
            <TableHead>Выдан</TableHead>
            <TableHead>Действует до</TableHead>
            <TableHead>Статус</TableHead>
            <TableHead className="text-right">Действия</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                Документов пока нет.
              </TableCell>
            </TableRow>
          )}
          {documents.map((doc) => (
            <TableRow key={doc.id}>
              <TableCell className="font-medium">{doc.title}</TableCell>
              <TableCell>{doc.documentType || '—'}</TableCell>
              <TableCell>{doc.documentNumber || '—'}</TableCell>
              <TableCell>{formatDate(doc.issueDate)}</TableCell>
              <TableCell>{formatDate(doc.expiryDate)}</TableCell>
              <TableCell>
                <Badge variant={doc.isActive ? 'default' : 'secondary'}>
                  {doc.isActive ? 'Действует' : 'Недействителен'}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  <DocumentFormDialog
                    document={doc}
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
