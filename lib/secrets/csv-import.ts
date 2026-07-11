/**
 * Маппинг разобранного CSV в карточки секретов (vault Ф3). Чистый модуль
 * (юнит-тестируется) — без БД и шифрования. Распознаёт колонки экспортов
 * браузерных менеджеров паролей (Chrome/Firefox: name,url,username,password,note),
 * неизвестные колонки не теряет — кладёт полем с исходным заголовком.
 */

export type ImportFieldKind = 'text' | 'secret' | 'url';
export type ParsedImportField = { name: string; kind: ImportFieldKind; value: string };
export type ParsedImportCard = { title: string; fields: ParsedImportField[] };
export type CsvImportResult = { cards: ParsedImportCard[]; skipped: number };

const MAX_ROWS = 5000;
const MAX_VALUE = 262144; // 256 КБ — как поле карточки (анти-abuse)

// Заголовок → человекочитаемое имя поля + тип. Ключи — в нижнем регистре.
type ColumnRule = { name: string; kind: ImportFieldKind };
const COLUMN_RULES: Array<{ match: string[]; rule: ColumnRule }> = [
  { match: ['url', 'website', 'ссылка', 'сайт', 'адрес'], rule: { name: 'Ссылка', kind: 'url' } },
  {
    match: ['username', 'user', 'login', 'логин', 'email', 'e-mail', 'почта', 'мейл'],
    rule: { name: 'Логин', kind: 'text' },
  },
  { match: ['password', 'pass', 'pwd', 'пароль'], rule: { name: 'Пароль', kind: 'secret' } },
  { match: ['otpauth', 'totp', 'otp', '2fa'], rule: { name: 'TOTP', kind: 'secret' } },
  {
    match: ['note', 'notes', 'comment', 'comments', 'заметка', 'заметки', 'описание', 'комментарий'],
    rule: { name: 'Заметка', kind: 'text' },
  },
];

const TITLE_HEADERS = ['name', 'title', 'наименование', 'имя', 'название'];

function ruleFor(header: string): ColumnRule | null {
  const h = header.trim().toLowerCase();
  for (const { match, rule } of COLUMN_RULES) if (match.includes(h)) return rule;
  return null;
}

/**
 * Первая запись — заголовок. Возвращает карточки (title + поля) и число
 * пропущенных строк (пустой title или битая структура). Значения не шифрует.
 */
export function mapCsvToCards(rows: string[][]): CsvImportResult {
  if (rows.length < 2) return { cards: [], skipped: 0 };
  const header = rows[0]!.map((h) => h.trim());

  // Индекс колонки-наименования: по известным заголовкам, иначе первая колонка.
  let titleIdx = header.findIndex((h) => TITLE_HEADERS.includes(h.toLowerCase()));
  if (titleIdx === -1) titleIdx = 0;

  const cards: ParsedImportCard[] = [];
  let skipped = 0;

  for (const row of rows.slice(1, MAX_ROWS + 1)) {
    const title = (row[titleIdx] ?? '').trim();
    if (!title) {
      skipped += 1;
      continue;
    }

    const fields: ParsedImportField[] = [];
    const usedNames = new Set<string>();
    for (let c = 0; c < header.length; c++) {
      if (c === titleIdx) continue;
      const raw = (row[c] ?? '').trim();
      if (!raw) continue;
      const rule = ruleFor(header[c] ?? '');
      const baseName = rule?.name ?? (header[c] || `Поле ${c + 1}`).trim();
      // Уникальность имени поля в карточке (ограничение secrets_card_field).
      let name = baseName;
      let n = 2;
      while (usedNames.has(name.toLowerCase())) name = `${baseName} ${n++}`;
      usedNames.add(name.toLowerCase());
      fields.push({ name, kind: rule?.kind ?? 'text', value: raw.slice(0, MAX_VALUE) });
    }

    cards.push({ title: title.slice(0, 500), fields });
  }

  return { cards, skipped };
}
