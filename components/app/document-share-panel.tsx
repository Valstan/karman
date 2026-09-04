'use client';

import { useMemo, useState } from 'react';
import { composeExport, renderText, type ExportDocument, type ExportPerson } from '@/lib/export/compose';
import { sanitizeFileName } from '@/lib/files/name';
import { ExportActions } from './export-actions';

/**
 * «Поделиться» своими документами — одним или выбранными галочками. Тот же
 * сборщик и те же кнопки, что у выгрузки круга; человек в блоке один — я сам,
 * поля карточки не выгружаются (это раздел документов, а не карточки).
 *
 * Файлы забираются через роут своих документов (`/api/documents/…`), а не
 * через роут круга: там проверка владения, здесь она и нужна.
 */
export function DocumentSharePanel({
  me,
  documents,
  today,
  compact = false,
}: {
  me: ExportPerson;
  /** Уже отобранные документы — панель ничего не фильтрует сама. */
  documents: ExportDocument[];
  today: string;
  /** Короткий вид без заголовка предпросмотра — для диалога одного документа. */
  compact?: boolean;
}) {
  const [withFiles, setWithFiles] = useState(false);

  const blocks = useMemo(
    () =>
      composeExport([me], documents, {
        personIds: [me.userId],
        fieldKeys: [],
        documentIds: documents.map((d) => d.id),
      }),
    [me, documents],
  );
  const text = useMemo(() => renderText(blocks, withFiles), [blocks, withFiles]);

  const files = useMemo(
    () =>
      withFiles
        ? documents.flatMap((doc) =>
            doc.files.map((file, index) => ({
              id: file.id,
              isImage: file.isImage,
              name: file.originalName || sanitizeFileName(`${doc.title}-${index + 1}`) || 'файл',
              docId: doc.id,
            })),
          )
        : [],
    [documents, withFiles],
  );
  const fileDoc = useMemo(() => new Map(files.map((f) => [f.id, f.docId])), [files]);
  const fileCount = documents.reduce((n, d) => n + d.files.length, 0);

  const subject = documents.length === 1 ? documents[0]!.title : `Документы (${documents.length})`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {documents.length === 0
            ? 'Ничего не выбрано.'
            : `Документов: ${documents.length}` + (fileCount > 0 ? `, файлов ${fileCount}` : '')}
        </p>
        {fileCount > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={withFiles}
              onChange={(e) => setWithFiles(e.target.checked)}
            />
            Вместе с файлами
          </label>
        )}
      </div>
      <ExportActions
        blocks={blocks}
        text={text}
        files={files}
        fileUrl={(id) => `/api/documents/${fileDoc.get(id) ?? 0}/files/${id}`}
        today={today}
        subject={subject}
      />
      <pre
        className={
          'print-area overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm ' +
          (compact ? 'max-h-64' : 'max-h-96')
        }
      >
        {text === '' ? 'Нечего показывать: документ пуст или ничего не выбрано.' : text}
      </pre>
    </div>
  );
}
