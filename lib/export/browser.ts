import { uniqueFileName } from '@/lib/files/name';
import type { ExportPersonBlock } from '@/lib/export/compose';

/**
 * Браузерная часть выгрузки — ОДНА для всех экранов: «Документы» (свой документ,
 * выбранные галочками), «Круг → Выгрузка». Всё собирается в браузере: данные уже
 * пришли на страницу серверным компонентом ровно те, что человеку открыты, и
 * отдельный API выгрузки был бы вторым местом, где решается «что кому
 * показывать». Файлы для архива и «Поделиться» браузер забирает по одному
 * через авторизованный роут, адрес которого даёт вызывающий (`fileUrl`): у
 * своих документов и у документов круга роуты разные, а проверка доступа — в них.
 *
 * Модуль без React: функции принимают готовый текст и блоки и ничего не знают
 * про состояние экрана.
 */

export type ExportFileRef = {
  id: number;
  name: string;
  isImage: boolean;
};

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Некоторые браузеры начинают скачивание асинхронно — нельзя отозвать объект
  // в том же тике.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** BOM — чтобы Блокнот на Windows не показал кириллицу кракозябрами. */
export function textBlob(text: string): Blob {
  return new Blob([`﻿${text}`], { type: 'text/plain;charset=utf-8' });
}

/** Word — библиотека грузится по требованию: весит заметно, нужна не каждому. */
export async function buildDocx(blocks: ExportPersonBlock[], withFileNames: boolean): Promise<Blob> {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import('docx');
  const line = (label: string, value: string) =>
    new Paragraph({
      children: [new TextRun({ text: `${label}: `, bold: true }), new TextRun(value)],
    });
  const children = blocks.flatMap((person) => {
    const parts = [
      new Paragraph({ text: person.name, heading: HeadingLevel.HEADING_1 }),
      ...person.lines.map((l) => line(l.label, l.value)),
    ];
    for (const doc of person.documents) {
      parts.push(new Paragraph({ text: doc.title, heading: HeadingLevel.HEADING_2 }));
      for (const l of doc.lines) parts.push(line(l.label, l.value));
      if (withFileNames && doc.fileNames.length > 0) {
        parts.push(new Paragraph({ text: `Файлы: ${doc.fileNames.join(', ')}` }));
      }
    }
    return parts;
  });
  return Packer.toBlob(new Document({ sections: [{ children }] }));
}

/**
 * ZIP: текст плюс файлы (если переданы). Имена в архиве разводятся: JSZip кладёт
 * записи в объект по имени и при совпадении молча перезаписывает — два паспорта,
 * снятые на один телефон и потому названные одинаково, дали бы один файл.
 * Возвращает число файлов, которые скачать не удалось: молчаливо неполный
 * архив — худший исход, человек уносит его как копию и узнаёт о пропаже, когда
 * она понадобится.
 */
export async function buildZip(
  textFileName: string,
  text: string,
  files: ExportFileRef[],
  fileUrl: (id: number) => string,
): Promise<{ blob: Blob; failed: number }> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file(textFileName, `﻿${text}`);
  let failed = 0;
  const usedNames = new Set<string>();
  for (const file of files) {
    const res = await fetch(fileUrl(file.id));
    if (!res.ok) {
      failed += 1;
      continue;
    }
    zip.file(`Файлы/${uniqueFileName(file.name, usedNames)}`, await res.blob());
  }
  return { blob: await zip.generateAsync({ type: 'blob' }), failed };
}

export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

/**
 * «Поделиться»: системное меню, если браузер умеет, иначе — в буфер обмена.
 * Картинки прикладываются, только если браузер умеет делиться файлами И они
 * переданы; умеет ли — выясняем ДО загрузки пустышкой того же типа, иначе на
 * платформе без поддержки мы качаем мегабайты сканов, чтобы их выбросить.
 */
export async function shareText(
  text: string,
  images: ExportFileRef[],
  fileUrl: (id: number) => string,
): Promise<ShareOutcome> {
  if (typeof navigator === 'undefined' || !navigator.share) {
    await navigator.clipboard.writeText(text);
    return 'copied';
  }
  try {
    let files: File[] = [];
    const wanted = images.filter((f) => f.isImage).slice(0, 10);
    const canShareFiles =
      wanted.length > 0 &&
      navigator.canShare?.({
        files: [new File([new Uint8Array()], 'probe.jpg', { type: 'image/jpeg' })],
      }) === true;
    if (canShareFiles) {
      const fetched = await Promise.all(
        wanted.map(async (image) => {
          const res = await fetch(fileUrl(image.id));
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
    return 'shared';
  } catch (e) {
    // Отмена — это не ошибка: человек открыл меню и передумал.
    if (e instanceof Error && e.name === 'AbortError') return 'cancelled';
    return 'failed';
  }
}

/**
 * Письмо: `mailto:` с текстом в теле. Почтовые клиенты режут длинные ссылки
 * (примерно 2 000 символов у самых строгих), поэтому вызывающий получает
 * признак «текст обрезан» и предупреждает человека — вложения через `mailto:`
 * не передаются в принципе, для файлов есть архив.
 */
export function mailtoHref(subject: string, text: string): { href: string; truncated: boolean } {
  const LIMIT = 1800;
  const truncated = text.length > LIMIT;
  const body = truncated ? `${text.slice(0, LIMIT)}\n\n…(текст обрезан — полная версия в файле)` : text;
  return {
    href: `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    truncated,
  };
}
