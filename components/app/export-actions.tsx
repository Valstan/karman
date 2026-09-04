'use client';

import { useState } from 'react';
import { Download, Mail, Printer, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { exportFileName, type ExportPersonBlock } from '@/lib/export/compose';
import {
  buildDocx,
  buildZip,
  downloadBlob,
  mailtoHref,
  shareText,
  textBlob,
  type ExportFileRef,
} from '@/lib/export/browser';

/**
 * Ряд кнопок «забрать»: текст, Word, архив, печать, письмо, поделиться. Один
 * компонент для своего документа, для выбранных галочками и для выгрузки круга —
 * иначе пять путей наружу расходятся по одному (как «Вместе с файлами», которая
 * 04.09 работала в четырёх из пяти).
 *
 * Печать печатает `.print-area` страницы (см. `@media print` в globals.css):
 * вызывающий обязан отрисовать текст в таком блоке — обычно это предпросмотр.
 */
export function ExportActions({
  blocks,
  text,
  files,
  fileUrl,
  today,
  subject,
  disabled = false,
}: {
  blocks: ExportPersonBlock[];
  text: string;
  /** Файлы, которые уедут в архив и в «Поделиться»; пусто — только текст. */
  files: ExportFileRef[];
  fileUrl: (id: number) => string;
  today: string;
  /** Тема письма и подпись к «Поделиться». */
  subject: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const isEmpty = blocks.length === 0 || text.trim() === '';
  const withFileNames = files.length > 0;
  const name = (ext: string) => exportFileName(ext, today || 'export');

  function guard(): boolean {
    if (isEmpty) {
      toast.error('Нечего выгружать — ничего не выбрано или всё пусто');
      return false;
    }
    return true;
  }

  async function run(label: string, job: () => Promise<void>) {
    if (!guard()) return;
    setBusy(true);
    try {
      await job();
    } catch {
      toast.error(`Не удалось: ${label}`);
    } finally {
      setBusy(false);
    }
  }

  const off = disabled || busy;

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={off}
        onClick={() => {
          if (guard()) downloadBlob(textBlob(text), name('txt'));
        }}
      >
        <Download className="mr-1 h-4 w-4" /> Текстом (.txt)
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={off}
        onClick={() =>
          run('собрать Word', async () => {
            downloadBlob(await buildDocx(blocks, withFileNames), name('docx'));
          })
        }
      >
        <Download className="mr-1 h-4 w-4" /> Word (.docx)
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={off}
        onClick={() =>
          run('собрать архив', async () => {
            const { blob, failed } = await buildZip(name('txt'), text, files, fileUrl);
            downloadBlob(blob, name('zip'));
            if (failed > 0) toast.error(`Не удалось добавить файлов: ${failed}`);
          })
        }
      >
        <Download className="mr-1 h-4 w-4" /> Архив (.zip)
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={off}
        onClick={() => {
          if (guard()) window.print();
        }}
      >
        <Printer className="mr-1 h-4 w-4" /> Печать
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={off}
        onClick={() => {
          if (!guard()) return;
          const { href, truncated } = mailtoHref(subject, text);
          if (truncated) toast.message('Письмо длинное — текст обрезан, полная версия в .txt');
          window.location.href = href;
        }}
      >
        <Mail className="mr-1 h-4 w-4" /> Почтой
      </Button>
      <Button
        type="button"
        disabled={off}
        onClick={() =>
          run('поделиться', async () => {
            const outcome = await shareText(text, files, fileUrl);
            if (outcome === 'copied') toast.success('Скопировано — вставьте в мессенджер');
            if (outcome === 'failed') toast.error('Не удалось поделиться');
          })
        }
      >
        <Share2 className="mr-1 h-4 w-4" /> Поделиться
      </Button>
    </div>
  );
}
