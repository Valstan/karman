/**
 * Парсер CSV (RFC 4180-ish) — для импорта. Чистый модуль (юнит-тестируется).
 * Поддержка: кавычки с удвоением `""`, поля с разделителем/переводом строки
 * внутри кавычек, записи через CRLF или LF, ведущий BOM, авто-детект разделителя
 * (`,` браузерных экспортов / `;` ru-Excel / таб).
 */

const DELIMITERS = [',', ';', '\t'] as const;
type Delimiter = (typeof DELIMITERS)[number];

/** Разделитель по первой строке (вне кавычек) — самый частый из `, ; \t`. */
export function detectDelimiter(text: string): Delimiter {
  const firstLine = stripBom(text).split(/\r?\n/, 1)[0] ?? '';
  let inQuotes = false;
  const counts: Record<Delimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (DELIMITERS as readonly string[]).includes(ch)) counts[ch as Delimiter] += 1;
  }
  return DELIMITERS.reduce((best, d) => (counts[d] > counts[best] ? d : best), ',' as Delimiter);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Разбирает CSV в массив записей (каждая — массив полей). Пустые строки
 * пропускаются. Разделитель — переданный или авто-детект.
 */
export function parseCsv(input: string, delimiter?: Delimiter): string[][] {
  const text = stripBom(input);
  const delim = delimiter ?? detectDelimiter(input);
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // Пропускаем полностью пустые строки (один пустой элемент).
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delim) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Хвост без завершающего перевода строки.
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}
