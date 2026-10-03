/**
 * Сборка CSV для Excel (ru-RU): UTF-8 BOM (иначе Excel ломает кириллицу),
 * разделитель `;` (русская локаль Excel), перевод строки CRLF. Чистый модуль.
 *
 * ## Нейтрализация формул (аудит #057, I1)
 *
 * Кавычек и `;` для этого мало: Excel исполняет формулу и в кавычках. Значение, начатое
 * с `=`, `+`, `-`, `@`, таба или CR, табличный редактор трактует как формулу — это
 * `WEBSERVICE`-вызов наружу, DDE-запуск (на старых сборках) и подмена содержимого.
 *
 * Единственное поле, где значение, записанное ЧУЖИМ пользователем, физически доходит до
 * чужой выгрузки, — название банка из общего справочника (`credits_bank` намеренно без
 * `user_id`). Поэтому префикс `'` ставится здесь, на выходе: правится один раз и закрывает
 * все три CSV-роута, а не каждый по отдельности.
 */

const BOM = String.fromCharCode(0xfeff); // U+FEFF
const DELIMITER = ';';
const NEWLINE = '\r\n';

/** Первый символ, с которого табличный редактор считает поле формулой. */
const FORMULA_START = /^[=+\-@\t\r]/;

function escapeField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (s === '') return '';
  // Апостроф Excel читает как «это текст, не формула» и в самой ячейке не показывает.
  if (FORMULA_START.test(s)) s = `'${s}`;
  // Поля с разделителем, кавычкой или переводом строки — в кавычках, внутренние удваиваем.
  if (/[";\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildCsv(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeField).join(DELIMITER));
  return BOM + lines.join(NEWLINE) + NEWLINE;
}

/** "1234.5" → "1234,50" (десятичная запятая для ru-Excel). Пусто/не число → "". */
export function csvMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n.toFixed(2).replace('.', ',') : '';
}

/** "YYYY-MM-DD" → "DD.MM.YYYY". Пусто/нет → "". */
export function csvDate(value: string | null | undefined): string {
  if (!value) return '';
  const [y, m, d] = value.split('-');
  if (!y || !m || !d) return value;
  return `${d}.${m}.${y}`;
}
