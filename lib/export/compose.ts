import { PROFILE_FIELDS, formatProfileValue, type ProfileFieldKey } from '@/lib/profile/fields';

/**
 * Сборка выгрузки: выбранные ПОЛЯ у выбранных ЛЮДЕЙ плюс выбранные документы.
 *
 * Модуль чистый и без `server-only` намеренно: ровно эта структура нужна и на
 * клиенте (текст для «Поделиться», содержимое .txt и .docx собираются в
 * браузере), и в тестах. Всё, что зависит от формата вывода, живёт снаружи —
 * здесь только «что и в каком порядке».
 *
 * Пустые значения ВЫБРАСЫВАЮТСЯ: строка «СНИЛС: » в распечатке хуже, чем её
 * отсутствие — она выглядит как утерянные данные, а не как незаполненное поле.
 */

export type ExportPerson = {
  userId: number;
  name: string;
  profile: Record<string, string>;
};

export type ExportDocument = {
  id: number;
  ownerUserId: number;
  title: string;
  documentType: string;
  documentNumber: string;
  issueDate: string | null;
  expiryDate: string | null;
  issuingAuthority: string;
  fields: { name: string; value: string }[];
  files: { id: number; originalName: string; isImage: boolean }[];
};

export type ExportSelection = {
  personIds: number[];
  fieldKeys: ProfileFieldKey[];
  documentIds: number[];
};

/** Одна строка выгрузки: подпись и значение. */
export type ExportLine = { label: string; value: string };

/** Документ в выгрузке — заголовок, строки и имена файлов. */
export type ExportDocumentBlock = {
  id: number;
  title: string;
  lines: ExportLine[];
  fileNames: string[];
};

/** Человек в выгрузке — имя, строки карточки и его документы. */
export type ExportPersonBlock = {
  userId: number;
  name: string;
  lines: ExportLine[];
  documents: ExportDocumentBlock[];
};

function documentCoreLines(doc: ExportDocument): ExportLine[] {
  const lines: ExportLine[] = [];
  if (doc.documentType.trim() !== '') lines.push({ label: 'Вид', value: doc.documentType });
  if (doc.documentNumber.trim() !== '') lines.push({ label: 'Номер', value: doc.documentNumber });
  if (doc.issueDate) {
    lines.push({ label: 'Дата выдачи', value: formatProfileValue('date', doc.issueDate) });
  }
  if (doc.expiryDate) {
    lines.push({ label: 'Действует до', value: formatProfileValue('date', doc.expiryDate) });
  }
  if (doc.issuingAuthority.trim() !== '') {
    lines.push({ label: 'Кем выдан', value: doc.issuingAuthority });
  }
  return lines;
}

/**
 * Собирает выгрузку по выбору. Порядок людей и полей — как в исходных списках,
 * а не как в выборе: человек ставит галочки вразнобой, но ждёт привычного
 * порядка (сначала фамилия, потом имя), а не порядка кликов.
 */
export function composeExport(
  people: ExportPerson[],
  documents: ExportDocument[],
  selection: ExportSelection,
): ExportPersonBlock[] {
  const personIds = new Set(selection.personIds);
  const fieldKeys = new Set<string>(selection.fieldKeys);
  const documentIds = new Set(selection.documentIds);

  return people
    .filter((person) => personIds.has(person.userId))
    .map((person) => {
      const lines = PROFILE_FIELDS.filter((field) => fieldKeys.has(field.key))
        .map((field) => ({
          label: field.label,
          value: formatProfileValue(field.kind, person.profile[field.key] ?? ''),
        }))
        .filter((line) => line.value !== '');

      const docs = documents
        .filter((doc) => doc.ownerUserId === person.userId && documentIds.has(doc.id))
        .map((doc) => ({
          id: doc.id,
          title: doc.title,
          lines: [
            ...documentCoreLines(doc),
            ...doc.fields
              .filter((f) => f.name.trim() !== '' && f.value.trim() !== '')
              .map((f) => ({ label: f.name, value: f.value })),
          ],
          fileNames: doc.files.map((f, index) => f.originalName || `файл ${index + 1}`),
        }));

      return { userId: person.userId, name: person.name, lines, documents: docs };
    })
    // Человек без единой заполненной строки и без документов в выгрузку не
    // попадает: пустой заголовок с именем читается как «данных нет вообще»,
    // хотя на деле просто не выбрано ни одно из заполненных полей.
    .filter((block) => block.lines.length > 0 || block.documents.length > 0);
}

/**
 * Плоский текст — для .txt, для буфера обмена и для «Поделиться». Тот же текст
 * уходит в мессенджер, поэтому никакой разметки: только отступы и переводы
 * строк, которые переживают любой транспорт.
 */
export function renderText(blocks: ExportPersonBlock[], withFileNames: boolean): string {
  const out: string[] = [];
  for (const person of blocks) {
    out.push(person.name);
    out.push('—'.repeat(Math.max(person.name.length, 3)));
    for (const line of person.lines) out.push(`${line.label}: ${line.value}`);
    for (const doc of person.documents) {
      out.push('');
      out.push(`  ${doc.title}`);
      for (const line of doc.lines) out.push(`  ${line.label}: ${line.value}`);
      if (withFileNames && doc.fileNames.length > 0) {
        out.push(`  Файлы: ${doc.fileNames.join(', ')}`);
      }
    }
    out.push('');
  }
  // Хвостовой перевод строки убираем: он даёт пустую строку в мессенджере и
  // лишнюю страницу в некоторых редакторах.
  return out.join('\n').trimEnd();
}

/** Имя файла выгрузки: дата приходит снаружи — в чистом модуле часов нет. */
export function exportFileName(extension: string, today: string): string {
  return `karman-${today}.${extension}`;
}
