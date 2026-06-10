'use client';

import { Fragment, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Trash2, Image as ImageIcon, Paperclip, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { rankMatches } from '@/lib/search/tiered-search';
import { HighlightedText } from './highlighted-text';
import type { DocumentListItem, DocumentCategoryOption } from '@/lib/services/documents';

type StatusFilter = 'all' | 'active' | 'inactive';

export function DocumentsTable({
  documents,
  categories,
}: {
  documents: DocumentListItem[];
  categories: DocumentCategoryOption[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [categoryId, setCategoryId] = useState<string>('all');

  // Многоуровневый поиск (#035): substring → subsequence → fuzzy, RU↔EN, подсветка.
  const { matches, layoutConverted } = useMemo(() => {
    const preFiltered = documents.filter((doc) => {
      if (status === 'active' && !doc.isActive) return false;
      if (status === 'inactive' && doc.isActive) return false;
      if (categoryId !== 'all' && String(doc.categoryId) !== categoryId) return false;
      return true;
    });
    return rankMatches(query, preFiltered, (doc) => [
      doc.title,
      doc.categoryName,
      doc.documentType,
      doc.documentNumber,
      doc.issuingAuthority,
    ]);
  }, [documents, query, status, categoryId]);

  const firstFuzzyIndex = matches.findIndex((m) => m.isFuzzy);

  const rangesFor = (matchIndex: number, field: number) =>
    matches[matchIndex]?.highlights.find((h) => h.field === field)?.ranges;

  async function remove(id: number) {
    const result = await deleteDocumentAction(id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Документ удалён');
    router.refresh();
  }

  const isFiltered = query.trim() !== '' || status !== 'all' || categoryId !== 'all';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск: название, тип, номер…"
            className="pl-8"
          />
        </div>
        <Select value={categoryId} onValueChange={setCategoryId}>
          <SelectTrigger className="sm:w-48">
            <SelectValue placeholder="Категория" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все категории</SelectItem>
            {categories.map((category) => (
              <SelectItem key={category.id} value={String(category.id)}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="sm:w-40">
            <SelectValue placeholder="Статус" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все статусы</SelectItem>
            <SelectItem value="active">Действующие</SelectItem>
            <SelectItem value="inactive">Недействительные</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {layoutConverted && (
        <p className="text-sm text-muted-foreground">
          В набранной раскладке ничего не нашлось — раскладка исправлена автоматически (RU↔EN).
        </p>
      )}

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
            {matches.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
                  {isFiltered ? 'Ничего не найдено.' : 'Документов пока нет.'}
                </TableCell>
              </TableRow>
            )}
            {matches.map(({ item: doc, isFuzzy }, index) => (
              <Fragment key={doc.id}>
                {isFuzzy && index === firstFuzzyIndex && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={9} className="py-1.5 text-xs text-muted-foreground">
                      Похожие (неточное совпадение):
                    </TableCell>
                  </TableRow>
                )}
              <TableRow>
                <TableCell className="font-medium">
                  <HighlightedText text={doc.title} ranges={rangesFor(index, 0)} />
                </TableCell>
                <TableCell>
                  {doc.categoryName ? (
                    <HighlightedText text={doc.categoryName} ranges={rangesFor(index, 1)} />
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell>
                  {doc.documentType ? (
                    <HighlightedText text={doc.documentType} ranges={rangesFor(index, 2)} />
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell>
                  {doc.documentNumber ? (
                    <HighlightedText text={doc.documentNumber} ranges={rangesFor(index, 3)} />
                  ) : (
                    '—'
                  )}
                </TableCell>
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
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
