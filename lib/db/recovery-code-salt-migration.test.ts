import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Соль recovery-кодов: миграция и схема обязаны говорить об одном (аудит #057 S2).
 *
 * Файл-гейт по образцу `session-epoch-migration.test.ts`: расхождение между миграцией и
 * схемой не ловится ни тестами приложения, ни сборкой — оно всплывает в бою, и тогда
 * ошибка чтения стоит всего одного раунда входа (Recovery-коды работают только в бою).
 *
 * Отдельно проверяется главное свойство переезда: колонка соли **nullable**. `NOT NULL`
 * здесь означало бы, что миграция ломает существующие 10 кодов владельца — то есть правка
 * безопасности отнимает у человека второй фактор. А `DEFAULT ''` был бы хуже: легаси-строки
 * получили бы соль и перестали проверяться молча, без ошибки.
 */
const ROOT = join(__dirname, '..', '..');

function read(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), 'utf8');
}

describe('соль recovery-кодов согласована в коде и миграции', () => {
  const migration = read('lib', 'db', 'migrations', '0020_recovery_codes_kdf.sql');
  const schema = read('lib', 'db', 'schema.ts');

  it('миграция добавляет колонку соли и ничего не удаляет', () => {
    expect(migration).toMatch(/ALTER TABLE auth_recovery_code ADD COLUMN code_salt/i);
    expect(migration).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
    // Обнулять соль нельзя: код без соли проверяется легаси-веткой, и это единственный
    // способ, которым живые коды владельца продолжают работать после миграции.
    expect(migration).not.toMatch(/UPDATE\s+auth_recovery_code/i);
  });

  it('колонка соли nullable: NOT NULL сломал бы живые коды при применении', () => {
    const column = migration.match(/ADD COLUMN code_salt[^;]*/i)?.[0] ?? '';
    expect(column).not.toMatch(/NOT NULL/i);
    expect(column).not.toMatch(/DEFAULT\s+'/i);
  });

  it('миграция объясняет совместимость со старыми кодами — вопрос задаст тот, кто её читает', () => {
    expect(migration).toMatch(/NULL|стар/i);
  });

  it('схема Drizzle знает ту же колонку и тоже nullable', () => {
    expect(schema).toMatch(/codeSalt: varchar\('code_salt', \{ length: 64 \}\),?\s*$/m);
  });
});
