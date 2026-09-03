'use client';

import { useMemo, useState } from 'react';
import { Download, FileText, Printer, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PROFILE_FIELDS, type ProfileFieldKey } from '@/lib/profile/fields';
import {
  composeExport,
  exportFileName,
  renderText,
  type ExportDocument,
  type ExportPerson,
} from '@/lib/export/compose';

/**
 * Выгрузка данных круга: галочки «какие поля × какие люди», плюс отдельные
 * галочки на документы и их файлы.
 *
 * Всё собирается В БРАУЗЕРЕ. Данные уже пришли на страницу серверным
 * компонентом (и пришли ровно те, что человеку открыты по согласию), поэтому
 * отдельный API-роут выгрузки был бы вторым местом, где решается вопрос
 * «что кому показывать», — а именно такие вторые места и расходятся с первым.
 * Файлы для архива браузер забирает по одному через авторизованный роут.
 */

const TODAY_FALLBACK = 'export';

type Props = {
  people: ExportPerson[];
  documents: ExportDocument[];
  today: string;
};

function useToggleSet<T>(initial: T[]) {
  const [items, setItems] = useState<Set<T>>(new Set(initial));
  const toggle = (value: T) =>
    setItems((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  const setAll = (values: T[]) => setItems(new Set(values));
  return { items, toggle, setAll };
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Освобождаем URL не сразу: Safari успевает не начать скачивание, если
  // отозвать объект в том же тике.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CircleExportPanel({ people, documents, today }: Props) {
  const persons = useToggleSet<number>(people.map((p) => p.userId));
  const fields = useToggleSet<ProfileFieldKey>(PROFILE_FIELDS.map((f) => f.key));
  const docs = useToggleSet<number>([]);
  const [withFiles, setWithFiles] = useState(false);
  const [busy, setBusy] = useState(false);

  const selection = useMemo(
    () => ({
      personIds: [...persons.items],
      fieldKeys: [...fields.items],
      documentIds: [...docs.items],
    }),
    [persons.items, fields.items, docs.items],
  );

  const blocks = useMemo(
    () => composeExport(people, documents, selection),
    [people, documents, selection],
  );
  const text = useMemo(() => renderText(blocks, withFiles), [blocks, withFiles]);
  const isEmpty = blocks.length === 0;

  /** Файлы выбранных документов — для ZIP и «Поделиться картинками». */
  const selectedFiles = useMemo(
    () =>
      documents
        .filter((doc) => docs.items.has(doc.id) && persons.items.has(doc.ownerUserId))
        .flatMap((doc) =>
          doc.files.map((file, index) => ({
            id: file.id,
            isImage: file.isImage,
            name: file.originalName || `${doc.title}-${index + 1}`,
            docTitle: doc.title,
          })),
        ),
    [documents, docs.items, persons.items],
  );

  function guard(): boolean {
    if (isEmpty) {
      toast.error('Ничего не выбрано — отметьте людей и поля');
      return false;
    }
    return true;
  }

  function downloadText() {
    if (!guard()) return;
    // BOM — чтобы Блокнот на Windows не показал кириллицу кракозябрами.
    const blob = new Blob([`﻿${text}`], { type: 'text/plain;charset=utf-8' });
    downloadBlob(blob, exportFileName('txt', today || TODAY_FALLBACK));
  }

  async function downloadWord() {
    if (!guard()) return;
    setBusy(true);
    try {
      // Библиотека грузится по требованию: она весит заметно, а Word нужен
      // далеко не в каждый заход на экран.
      const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import('docx');
      const children = blocks.flatMap((person) => {
        const parts = [
          new Paragraph({ text: person.name, heading: HeadingLevel.HEADING_1 }),
          ...person.lines.map(
            (line) =>
              new Paragraph({
                children: [
                  new TextRun({ text: `${line.label}: `, bold: true }),
                  new TextRun(line.value),
                ],
              }),
          ),
        ];
        for (const doc of person.documents) {
          parts.push(new Paragraph({ text: doc.title, heading: HeadingLevel.HEADING_2 }));
          for (const line of doc.lines) {
            parts.push(
              new Paragraph({
                children: [
                  new TextRun({ text: `${line.label}: `, bold: true }),
                  new TextRun(line.value),
                ],
              }),
            );
          }
          if (withFiles && doc.fileNames.length > 0) {
            parts.push(new Paragraph({ text: `Файлы: ${doc.fileNames.join(', ')}` }));
          }
        }
        return parts;
      });

      const document = new Document({ sections: [{ children }] });
      const blob = await Packer.toBlob(document);
      downloadBlob(blob, exportFileName('docx', today || TODAY_FALLBACK));
    } catch {
      toast.error('Не удалось собрать документ Word');
    } finally {
      setBusy(false);
    }
  }

  async function downloadZip() {
    if (!guard()) return;
    setBusy(true);
    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      zip.file(exportFileName('txt', today || TODAY_FALLBACK), `﻿${text}`);

      let failed = 0;
      // Файлы качаются по одному через авторизованный роут: сервер архив не
      // собирает и не держит его в памяти.
      for (const file of selectedFiles) {
        const res = await fetch(`/api/circle/files/${file.id}`);
        if (!res.ok) {
          failed += 1;
          continue;
        }
        zip.file(`Файлы/${file.name}`, await res.blob());
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, exportFileName('zip', today || TODAY_FALLBACK));
      // Молчаливо неполный архив — худший исход: человек уносит его как копию
      // документов и узнает о пропаже, когда она понадобится.
      if (failed > 0) toast.error(`Не удалось добавить файлов: ${failed}`);
    } catch {
      toast.error('Не удалось собрать архив');
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    if (!guard()) return;
    if (typeof navigator === 'undefined' || !navigator.share) {
      await navigator.clipboard.writeText(text);
      toast.success('Скопировано — вставьте в мессенджер');
      return;
    }
    setBusy(true);
    try {
      // Картинки прикладываются, только если браузер это умеет И они выбраны.
      // Проверка canShare обязательна: Android отдаёт navigator.share, но
      // делиться файлами умеет не везде, и без проверки вызов падает.
      const images = withFiles ? selectedFiles.filter((f) => f.isImage).slice(0, 10) : [];
      let files: File[] = [];
      if (images.length > 0) {
        const fetched = await Promise.all(
          images.map(async (image) => {
            const res = await fetch(`/api/circle/files/${image.id}`);
            if (!res.ok) return null;
            const blob = await res.blob();
            return new File([blob], image.name, { type: blob.type });
          }),
        );
        files = fetched.filter((f): f is File => f !== null);
      }

      if (files.length > 0 && navigator.canShare?.({ files })) {
        await navigator.share({ text, files });
      } else {
        await navigator.share({ text });
      }
    } catch (e) {
      // Отмена — это не ошибка: человек открыл меню и передумал.
      if (e instanceof Error && e.name === 'AbortError') return;
      toast.error('Не удалось поделиться');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle className="text-base">Кого выгружаем</CardTitle>
                <CardDescription>Выбрано: {persons.items.size} из {people.length}</CardDescription>
              </div>
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => persons.setAll(people.map((p) => p.userId))}
                >
                  Все
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => persons.setAll([])}>
                  Никого
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {people.map((person) => (
              <label key={person.userId} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={persons.items.has(person.userId)}
                  onChange={() => persons.toggle(person.userId)}
                />
                {person.name}
              </label>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle className="text-base">Какие поля</CardTitle>
                <CardDescription>
                  Выбрано: {fields.items.size} из {PROFILE_FIELDS.length}
                </CardDescription>
              </div>
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => fields.setAll(PROFILE_FIELDS.map((f) => f.key))}
                >
                  Все
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => fields.setAll([])}>
                  Ничего
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            {PROFILE_FIELDS.map((field) => (
              <label key={field.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={fields.items.has(field.key)}
                  onChange={() => fields.toggle(field.key)}
                />
                {field.label}
              </label>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">Документы</CardTitle>
              <CardDescription>
                По умолчанию не выгружаются — отметьте нужные. Документы людей, снятых
                галочкой выше, в выгрузку не попадут.
              </CardDescription>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={withFiles}
                onChange={(e) => setWithFiles(e.target.checked)}
              />
              Вместе с файлами
            </label>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {documents.length === 0 && (
            <p className="text-sm text-muted-foreground">Документов в круге пока нет.</p>
          )}
          {documents.map((doc) => {
            const owner = people.find((p) => p.userId === doc.ownerUserId);
            return (
              <label key={doc.id} className="flex flex-wrap items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={docs.items.has(doc.id)}
                  onChange={() => docs.toggle(doc.id)}
                />
                <span className="font-medium">{doc.title}</span>
                <Badge variant="secondary">{owner?.name ?? '—'}</Badge>
                {doc.files.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <FileText className="h-3 w-3" /> {doc.files.length}
                  </span>
                )}
              </label>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Забрать</CardTitle>
          <CardDescription>
            {isEmpty
              ? 'Пока ничего не выбрано.'
              : `Готово к выгрузке: ${blocks.length} чел.` +
                (withFiles && selectedFiles.length > 0 ? `, файлов ${selectedFiles.length}` : '')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={downloadText}>
            <Download className="mr-1 h-4 w-4" /> Текстом (.txt)
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={downloadWord}>
            <Download className="mr-1 h-4 w-4" /> Word (.docx)
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={downloadZip}>
            <Download className="mr-1 h-4 w-4" /> Архив (.zip)
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (guard()) window.print();
            }}
          >
            <Printer className="mr-1 h-4 w-4" /> Печать
          </Button>
          <Button type="button" disabled={busy} onClick={share}>
            <Share2 className="mr-1 h-4 w-4" /> Поделиться
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Предпросмотр</CardTitle>
          <CardDescription>Ровно это уедет в файл, в печать и в мессенджер.</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="print-area max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm">
            {text === '' ? 'Ничего не выбрано.' : text}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
