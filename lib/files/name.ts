/**
 * Имена файлов — чистый модуль БЕЗ `node:path`, поэтому его импортирует и
 * сервер (хранилище сканов), и клиент (сборка ZIP в браузере). Это и есть
 * причина отдельного файла: `lib/storage/media-paths.ts` тянет `node:path` на
 * уровне модуля, и клиентский бандл на нём спотыкается.
 */

/**
 * Чистит имя файла: убирает разделители пути и символы, запрещённые в именах
 * файлов, схлопывает многоточия и снимает ведущие точки.
 *
 * Имя приходит от человека (File.name при загрузке, название документа при
 * сборке архива) и попадает в имя записи ZIP, где `../` уводит распаковку за
 * пределы каталога — классический zip-slip, — а ведущая точка прячет файл.
 *
 * Пробелы и дефисы НЕ трогаются: «паспорт разворот 2.jpg» обязан остаться
 * читаемым — ради этого имя и хранится отдельно от пути на диске.
 */
export function sanitizeFileName(value: string): string {
  const withoutSeparators = value.replace(/[/\\]/g, '');
  const withoutIllegal = withoutSeparators.replace(/[:*?"<>|]/g, '');
  return withoutIllegal
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .trim();
}

/**
 * Разводит совпадающие имена внутри одного архива: JSZip кладёт записи в объект
 * по имени и при совпадении МОЛЧА перезаписывает — два паспорта, снятые на один
 * телефон и потому названные одинаково, дали бы в архиве один файл, и пропажу
 * человек заметил бы не сразу.
 *
 * `used` изменяется на месте: вызывающий заводит один набор на архив.
 */
export function uniqueFileName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  // Точка в начале уже снята sanitizeFileName, поэтому dot > 0 — это настоящее
  // расширение, а не скрытый файл вида «.gitignore».
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (${n})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}
