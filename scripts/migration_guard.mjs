#!/usr/bin/env node
/**
 * migration_guard.mjs — сверка списка миграций репозитория с журналом на БД.
 *
 * ЗАЧЕМ. Гвард миграций отвечает на вопрос «код уезжает на прод раньше схемы»,
 * и ответить на него можно только по СОСТОЯНИЮ: список файлов
 * `lib/db/migrations/*.sql` против журнала `schema_migrations` в боевой БД.
 * Прежний предохранитель смотрел на diff последнего коммита и держал ровно
 * один push — дыра описана мозгу 28.07.
 *
 * КТО ЗАПУСКАЕТ. Шаг `Migration guard` в `.github/workflows/deploy-prod.yml`
 * (на раннере, список миграций — из репозитория, журнал — с боевой БД) и гейт
 * `lib/db/migration-journal.test.ts` (на pglite). Один и тот же код — чтобы
 * проверка не «разъехалась» на две копии.
 *
 * ФОРМАТ ВХОДА. `--journal` — файл со строками `version|name` (то, что печатает
 * `scripts/migration_journal.sh list`). Имя миграции берётся из второго поля;
 * строка без `|` трактуется как само имя.
 *
 * КОД ВЫХОДА: 0 — все миграции репозитория есть в журнале; 1 — есть
 * неприменённые (деплой останавливается); 2 — нечитаемый вход.
 *
 * Скрипт без зависимостей: на раннере он запускается до `npm ci`, а в гейте —
 * как отдельный процесс (импорт .mjs из TypeScript-теста ломал бы typecheck).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULTS = {
  migrations: 'lib/db/migrations',
  journal: null,
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--migrations' || arg === '--journal') {
      const value = argv[i + 1];
      if (!value) {
        console.error(`migration_guard: у ${arg} нет значения`);
        process.exit(2);
      }
      out[arg.slice(2)] = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/migration_guard.mjs [--migrations <dir>] --journal <file>');
      process.exit(0);
    } else {
      console.error(`migration_guard: неизвестный аргумент: ${arg}`);
      process.exit(2);
    }
  }
  return out;
}

/** Файлы миграций репозитория: имя файла, по алфавиту. */
function repoMigrations(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    console.error(`migration_guard: каталог миграций не прочитан (${dir}): ${e.message}`);
    process.exit(2);
  }
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

/** Имена миграций из журнала: строки `version|name` → второе поле. */
function journalNames(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`migration_guard: файл журнала не прочитан (${file}): ${e.message}`);
    process.exit(2);
  }
  const names = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('|');
    const name = (parts.length > 1 ? parts[1] : parts[0]).trim();
    if (name) names.add(name);
  }
  return names;
}

const args = parseArgs(process.argv.slice(2));
if (!args.journal) {
  console.error('migration_guard: нужен --journal <файл> (вывод scripts/migration_journal.sh list)');
  process.exit(2);
}

const repo = repoMigrations(args.migrations);
const applied = journalNames(args.journal);
const missing = repo.filter((f) => !applied.has(f));

console.log(`migration_guard: в репозитории ${repo.length} миграций, в журнале ${applied.size}`);
if (missing.length === 0) {
  console.log('migration_guard: все миграции репозитория есть в журнале — схема не отстаёт от кода.');
  process.exit(0);
}

console.error(`migration_guard: НЕ ПРИМЕНЕНЫ НА ПРОДЕ (${missing.length}):`);
for (const file of missing) {
  console.error(`::error::Миграция ${file} не применена на проде — код уехал бы на схему без неё.`);
}
console.error(
  '::error::Применить: gh workflow run apply-migration.yml --ref main -f migration=<файл из списка выше>',
);
process.exit(1);
