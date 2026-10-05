import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Гейт: каждая таблица схемы либо попадает в дамп `scripts/backup_vault.sh`,
 * либо перечислена в его `BACKUP_EXCLUDES` с причиной (pool #033, D-096).
 *
 * Класс дефекта — «таблица вне бэкапа», и он пойман ЧЕТЫРЕ раза, каждый раз
 * человеком, а не гейтом: `secrets_grant` (миграция 0006, месяц без бэкапа),
 * пять таблиц эпика документов, `passport_*`, и `family_*` (миграция 0018 —
 * восстановление отдало бы древо без людей). Общая черта всех четырёх: новую
 * таблицу создаёт миграция, а список в скрипте живёт в другом файле, и
 * ничто их не связывает. Проверка, живущая только в памятке, гейтом не
 * считается (#125) — отсюда этот файл, а не строчка в PENDING.
 *
 * Направление проверки одно — «в схеме, но не в дампе». Обратное (упомянута
 * таблица, которой в схеме нет) ловится тоже: опечатка в `-t` молча выдала бы
 * архив без этой таблицы, и `pg_dump` не ошибётся.
 */

const ROOT = join(__dirname, '..', '..');
const SCHEMA = readFileSync(join(ROOT, 'lib', 'db', 'schema.ts'), 'utf8');
const SCRIPT = readFileSync(join(ROOT, 'scripts', 'backup_vault.sh'), 'utf8');

/** Таблицы Drizzle-схемы: `pgTable('name', …)`. */
function schemaTables(): string[] {
  return [...SCHEMA.matchAll(/pgTable\(\s*'(\w+)'/g)].map((m) => m[1]!).sort();
}

/**
 * Таблицы в `-t` аргументах pg_dump. Их несколько на строке, поэтому без `m`.
 * Разбираем ТОЛЬКО сам вызов pg_dump: в скрипте есть и другие `-t` (`mapfile -t
 * REMOTE` в ретенции), и они к дампу отношения не имеют.
 */
function dumpedTables(): Set<string> {
  const call = SCRIPT.match(/pg_dump "\$DATABASE_URL"[\s\S]*?> "\$WORK\/vault\.sql"/);
  if (!call) throw new Error('в backup_vault.sh не найден вызов pg_dump (vault.sql)');
  return new Set([...call[0].matchAll(/(?:^|\s)-t (\w+)/g)].map((m) => m[1]!));
}

/** Исключения: строки `таблица|причина` внутри массива BACKUP_EXCLUDES. */
function excluded(): Map<string, string> {
  const block = SCRIPT.match(/BACKUP_EXCLUDES=\(([\s\S]*?)\n\)/);
  if (!block) throw new Error('в backup_vault.sh нет массива BACKUP_EXCLUDES');
  const out = new Map<string, string>();
  for (const raw of block[1]!.split('\n')) {
    const line = raw.trim().replace(/^"|"$/g, '');
    if (!line || line.startsWith('#')) continue;
    const [table, ...rest] = line.split('|');
    out.set(table!.trim(), rest.join('|').trim());
  }
  return out;
}

describe('дамп бэкапа догоняет схему', () => {
  const schema = schemaTables();
  const dumped = dumpedTables();
  const skips = excluded();

  it('список исключений разбирается и каждая причина непуста', () => {
    expect(skips.size, 'исключений не нашлось — гейт молчал бы вхолостую').toBeGreaterThan(0);
    const безПричины = [...skips].filter(([, reason]) => reason.length === 0).map(([t]) => t);
    expect(безПричины, `исключения без причины: ${безПричины.join(', ')}`).toEqual([]);
  });

  it('каждая таблица схемы либо в дампе, либо в исключениях с причиной', () => {
    const потеряно = schema.filter((t) => !dumped.has(t) && !skips.has(t));
    expect(
      потеряно,
      `таблицы вне бэкапа без записи в BACKUP_EXCLUDES: ${потеряно.join(', ')}. ` +
        'Либо добавь таблицу в pg_dump -t, либо объясни в BACKUP_EXCLUDES, почему она не нужна.',
    ).toEqual([]);
  });

  it('в дампе и исключениях нет таблиц, которых нет в схеме (опечатка в -t)', () => {
    const лишние = [...dumped, ...skips.keys()].filter((t) => !schema.includes(t));
    expect(лишние, `упомянуты несуществующие таблицы: ${лишние.join(', ')}`).toEqual([]);
  });

  it('исключения не пересекаются с дампом (одна и та же таблица дважды)', () => {
    const двойные = [...dumped].filter((t) => skips.has(t));
    expect(двойные, `таблица и в дампе, и в исключениях: ${двойные.join(', ')}`).toEqual([]);
  });
});