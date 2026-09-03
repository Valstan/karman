'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import type { DocumentFileItem } from '@/lib/services/documents';

/**
 * Файлы документа: развороты паспорта, страницы свидетельства, выгрузка из
 * госуслуг. До 2026-09-04 их было ровно три (по слотам), и второй файл в
 * занятый слот затирал первый.
 *
 * Файлы уходят на сервер ПО ОДНОМУ, а не пачкой: при отправке пачкой частичный
 * отказ (пятый превысил размер) не даёт понять, какие четыре доехали, — а
 * человек в этот момент смотрит на список и должен видеть правду.
 */

const ACCEPT = '.jpg,.jpeg,.png,.webp,.pdf';
const MAX_FILES = 20;

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function DocumentFilesPanel({
  documentId,
  files,
}: {
  documentId: number;
  files: DocumentFileItem[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    // Сбрасываем input сразу: без этого повторный выбор ТОГО ЖЕ файла не даёт
    // события change, и человек жмёт, а ничего не происходит.
    if (inputRef.current) inputRef.current.value = '';
    if (picked.length === 0) return;

    if (files.length + picked.length > MAX_FILES) {
      toast.error(`Больше ${MAX_FILES} файлов на документ нельзя`);
      return;
    }

    setBusy(true);
    let uploaded = 0;
    const errors: string[] = [];
    for (const [index, file] of picked.entries()) {
      setProgress({ done: index, total: picked.length });
      const body = new FormData();
      body.append('file', file);
      const res = await fetch(`/api/documents/${documentId}/files`, { method: 'POST', body });
      if (res.ok) {
        uploaded += 1;
      } else {
        const payload = (await res.json().catch(() => null)) as { message?: string } | null;
        errors.push(`${file.name}: ${payload?.message ?? 'не удалось загрузить'}`);
      }
    }
    setProgress(null);
    setBusy(false);

    // Сообщаем и про успех, и про отказ: молчаливая частичная загрузка —
    // худший исход, человек уходит с мыслью, что всё на месте.
    if (uploaded > 0) toast.success(`Загружено файлов: ${uploaded}`);
    for (const error of errors.slice(0, 3)) toast.error(error);
    if (errors.length > 3) toast.error(`…и ещё ${errors.length - 3}`);
    router.refresh();
  }

  async function remove(fileId: number) {
    setBusy(true);
    const res = await fetch(`/api/documents/${documentId}/files/${fileId}`, { method: 'DELETE' });
    setBusy(false);
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { message?: string } | null;
      toast.error(payload?.message ?? 'Не удалось удалить файл');
      return;
    }
    toast.success('Файл удалён');
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Файлы</CardTitle>
        <CardDescription>
          Сканы и электронные копии: JPG, PNG, WEBP, PDF, до 10 МБ каждый, не больше {MAX_FILES} на
          документ. Можно выбрать сразу несколько — многостраничный документ кладите страницами.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            ref={inputRef}
            id={`files-${documentId}`}
            type="file"
            accept={ACCEPT}
            multiple
            disabled={busy}
            onChange={onPick}
            className="sm:max-w-sm"
          />
          <span className="text-sm text-muted-foreground">
            {progress
              ? `Загрузка ${progress.done + 1} из ${progress.total}…`
              : `Прикреплено: ${files.length}`}
          </span>
        </div>

        {files.length === 0 ? (
          <p className="text-sm text-muted-foreground">Файлов пока нет.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {files.map((file, index) => (
              <li key={file.id} className="flex items-center gap-3 rounded-lg border p-2">
                <a
                  href={`/api/documents/${documentId}/files/${file.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0"
                  title="Открыть"
                >
                  {file.isImage ? (
                    // Приватный файл за авторизованным роутом — оптимизатор
                    // next/image до него не доберётся (у него нет сессии).
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/documents/${documentId}/files/${file.id}`}
                      alt={file.originalName || `Файл ${index + 1}`}
                      loading="lazy"
                      className="h-12 w-12 rounded border object-cover"
                    />
                  ) : (
                    <span className="flex h-12 w-12 items-center justify-center rounded border">
                      <FileText className="h-5 w-5 text-muted-foreground" />
                    </span>
                  )}
                </a>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {file.originalName || `Файл ${index + 1}`}
                  </p>
                  <p className="text-xs text-muted-foreground">{humanSize(file.sizeBytes)}</p>
                </div>
                <ConfirmDialog
                  title="Удалить файл?"
                  description="Файл будет стёрт с диска. Действие необратимо."
                  onConfirm={() => remove(file.id)}
                  trigger={
                    <Button size="icon" variant="ghost" title="Удалить" disabled={busy}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  }
                />
              </li>
            ))}
          </ul>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="mr-1 h-4 w-4" /> Выбрать файлы
        </Button>
      </CardContent>
    </Card>
  );
}
