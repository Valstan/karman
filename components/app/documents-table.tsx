'use client';

import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Pencil, Trash2, Search, FileText, Share2, Users, UserX } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
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
import { DocumentSharePanel } from './document-share-panel';
import { ConfirmDialog } from './confirm-dialog';
import { deleteDocumentAction, setCircleSharedAction } from '@/lib/actions/documents';
import { documentExpiryBadge } from '@/lib/constants';
import { formatDate } from '@/lib/format';
import { rankMatches } from '@/lib/search/tiered-search';
import { HighlightedText } from './highlighted-text';
import type { ExportDocument, ExportPerson } from '@/lib/export/compose';
import type { DocumentListItem, DocumentCategoryOption } from '@/lib/services/documents';

type StatusFilter = 'all' | 'active' | 'inactive';

/**
 * Обложка документа в списке: миниатюра первого файла-картинки, иконка — если
 * картинок нет, но файлы есть. Ведёт на экран документа.
 */
function DocumentThumb({
  docId,
  previewFileId,
  fileCount,
  title,
}: {
  docId: number;
  previewFileId: number | null;
  fileCount: number;
  title: string;
}) {
  if (fileCount === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <Link
      href={`/documents/${docId}`}
      title={`Файлов: ${fileCount}`}
      className="flex items-center gap-2 text-muted-foreground hover:text-foreground"
    >
      {previewFileId !== null ? (
        // Приватный файл за авторизованным API-роутом — оптимизатор next/image
        // его не достанет (нет сессии), поэтому обычный <img>.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/documents/${docId}/files/${previewFileId}`}
          alt={title}
          loading="lazy"
          className="h-10 w-10 rounded border object-cover"
        />
      ) : (
        <FileText className="h-4 w-4" />
      )}
      <span className="text-xs">{fileCount}</span>
    </Link>
  );
}

/** «Поделиться» одним документом — диалог с теми же кнопками, что у выборки. */
export function DocumentShareDialog({
  me,
  document,
  today,
  trigger,
}: {
  me: ExportPerson;
  document: ExportDocument;
  today: string;
  trigger: React.ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Поделиться: {document.title}</DialogTitle>
        </DialogHeader>
        <DocumentSharePanel me={me} documents={[document]} today={today} compact />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Список документов с галочками. Галочки — единственный «выбор»: и «поделиться»,
 * и «в круг» работают с отмеченными. Каждая строка при этом умеет поделиться
 * собой и без галочек — кнопкой в строке.
 */
export function DocumentsTable({
  documents,
  categories,
  exportDocuments,
  me,
  today,
}: {
  documents: DocumentListItem[];
  categories: DocumentCategoryOption[];
  exportDocuments: ExportDocument[];
  me: ExportPerson;
  today: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [categoryId, setCategoryId] = useState<string>('all');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

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

  const exportById = useMemo(() => new Map(exportDocuments.map((d) => [d.id, d])), [exportDocuments]);
  const selectedExport = useMemo(
    () => documents.filter((d) => selected.has(d.id)).map((d) => exportById.get(d.id)).filter(
      (d): d is ExportDocument => d !== undefined,
    ),
    [documents, selected, exportById],
  );

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const visibleIds = matches.map((m) => m.item.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  async function remove(id: number) {
    const result = await deleteDocumentAction(id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Документ удалён');
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    router.refresh();
  }

  async function shareToCircle(shared: boolean) {
    if (selected.size === 0) {
      toast.error('Отметьте документы галочками');
      return;
    }
    setBusy(true);
    try {
      const result = await setCircleSharedAction([...selected], shared);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(
        shared
          ? `Открыто кругу: ${result.data?.count ?? 0}`
          : `Забрано из круга: ${result.data?.count ?? 0}`,
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
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
              <TableHead className="w-8">
                <input
                  type="checkbox"
                  className="size-4"
                  aria-label="Выбрать все показанные"
                  checked={allVisibleSelected}
                  onChange={() =>
                    setSelected(allVisibleSelected ? new Set() : new Set(visibleIds))
                  }
                />
              </TableHead>
              <TableHead>Название</TableHead>
              <TableHead>Категория</TableHead>
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
                  {isFiltered ? 'Ничего не найдено.' : 'Документов пока нет — нажмите «Новый документ».'}
                </TableCell>
              </TableRow>
            )}
            {matches.map(({ item: doc, isFuzzy }, index) => {
              const exportDoc = exportById.get(doc.id);
              return (
                <Fragment key={doc.id}>
                  {isFuzzy && index === firstFuzzyIndex && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={9} className="py-1.5 text-xs text-muted-foreground">
                        Похожие (неточное совпадение):
                      </TableCell>
                    </TableRow>
                  )}
                  <TableRow data-state={selected.has(doc.id) ? 'selected' : undefined}>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="size-4"
                        aria-label={`Выбрать ${doc.title}`}
                        checked={selected.has(doc.id)}
                        onChange={() => toggle(doc.id)}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      <Link href={`/documents/${doc.id}`} className="hover:underline">
                        <HighlightedText text={doc.title} ranges={rangesFor(index, 0)} />
                      </Link>
                      {doc.documentType && doc.documentType !== doc.title && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          <HighlightedText text={doc.documentType} ranges={rangesFor(index, 2)} />
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {doc.categoryName ? (
                        <HighlightedText text={doc.categoryName} ranges={rangesFor(index, 1)} />
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
                          return badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : null;
                        })()}
                      </div>
                    </TableCell>
                    <TableCell>
                      <DocumentThumb
                        docId={doc.id}
                        previewFileId={doc.previewFileId}
                        fileCount={doc.fileCount}
                        title={doc.title}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant={doc.isActive ? 'default' : 'secondary'}>
                          {doc.isActive ? 'Действует' : 'Недействителен'}
                        </Badge>
                        {doc.circleSharedAt && (
                          <Badge variant="outline" title="Виден участникам круга">
                            <Users className="mr-1 h-3 w-3" /> В круге
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        {exportDoc && (
                          <DocumentShareDialog
                            me={me}
                            document={exportDoc}
                            today={today}
                            trigger={
                              <Button size="icon" variant="ghost" title="Поделиться">
                                <Share2 className="h-4 w-4" />
                              </Button>
                            }
                          />
                        )}
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
                          description="Действие необратимо: поля и файлы удалятся вместе с документом."
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
              );
            })}
          </TableBody>
        </Table>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">Выбранные документы</CardTitle>
              <CardDescription>
                {selected.size === 0
                  ? 'Отметьте галочками — и здесь появятся кнопки: в круг, почтой, файлом, в мессенджер.'
                  : `Отмечено: ${selected.size}`}
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy || selected.size === 0}
                onClick={() => shareToCircle(true)}
              >
                <Users className="mr-1 h-4 w-4" /> В круг
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy || selected.size === 0}
                onClick={() => shareToCircle(false)}
              >
                <UserX className="mr-1 h-4 w-4" /> Убрать из круга
              </Button>
            </div>
          </div>
        </CardHeader>
        {selected.size > 0 && (
          <CardContent>
            <DocumentSharePanel me={me} documents={selectedExport} today={today} />
          </CardContent>
        )}
      </Card>
    </div>
  );
}
