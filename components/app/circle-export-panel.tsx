'use client';

import { useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PROFILE_FIELDS, type ProfileFieldKey } from '@/lib/profile/fields';
import { sanitizeFileName } from '@/lib/files/name';
import { composeExport, renderText, type ExportDocument, type ExportPerson } from '@/lib/export/compose';
import { ExportActions } from './export-actions';

/**
 * Выгрузка данных круга: галочки «какие поля × какие люди», плюс отдельные
 * галочки на документы и их файлы.
 *
 * Всё собирается В БРАУЗЕРЕ. Данные уже пришли на страницу серверным
 * компонентом (и пришли ровно те, что человеку открыты по согласию), поэтому
 * отдельный API-роут выгрузки был бы вторым местом, где решается вопрос
 * «что кому показывать», — а именно такие вторые места и расходятся с первым.
 * Форматы и кнопки — общие с разделом «Документы» (`ExportActions`).
 */

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

export function CircleExportPanel({ people, documents, today }: Props) {
  const persons = useToggleSet<number>(people.map((p) => p.userId));
  const fields = useToggleSet<ProfileFieldKey>(PROFILE_FIELDS.map((f) => f.key));
  const docs = useToggleSet<number>([]);
  const [withFiles, setWithFiles] = useState(false);

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
            // Исходное имя санируется при загрузке, а вот запасное собирается
            // из названия документа — его человек вводит свободно, и без
            // чистки «Паспорт ../..» стал бы путём внутри архива.
            name: file.originalName || sanitizeFileName(`${doc.title}-${index + 1}`) || 'файл',
          })),
        ),
    [documents, docs.items, persons.items],
  );

  // Галочка «Вместе с файлами» — ЕДИНСТВЕННОЕ место, где решается, уедут ли
  // сканы; она распространяется на архив, «Поделиться» и имена в тексте.
  const files = withFiles ? selectedFiles : [];

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
                <CardTitle className="text-base">Какие поля карточки</CardTitle>
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
                Здесь свои документы и те, что родня открыла кругу. По умолчанию не
                выгружаются — отметьте нужные. Документы людей, снятых галочкой выше, в
                выгрузку не попадут.
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
                (files.length > 0 ? `, файлов ${files.length}` : '')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ExportActions
            blocks={blocks}
            text={text}
            files={files}
            fileUrl={(id) => `/api/circle/files/${id}`}
            today={today}
            subject="Данные круга"
          />
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
