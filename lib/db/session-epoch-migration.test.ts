import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Поколение сессии: миграция, схема и бутстрап должны говорить об одном (аудит #057 R2).
 *
 * Три места обязаны быть согласованы, и расхождение между ними не ловится ни тестами
 * приложения, ни сборкой:
 *
 * - `lib/db/migrations/0019_session_epoch.sql` — что реально применяется к боевой базе;
 * - `lib/db/schema.ts` — чем код читает и пишет;
 * - `scripts/bootstrap.sql` — чем поднимается ЧИСТАЯ база (без него развёртывание с нуля
 *   падает на `session_epoch`, которого в таблице нет, то есть первая же выдача сессии).
 *
 * Отдельно проверяется, что защита не «наполовину совместимая»: миграция обязана быть
 * аддитивной с `NOT NULL DEFAULT 0`, иначе либо ломаются существующие строки, либо
 * появляется окно, в котором счётчик можно выставить в ноль вручную.
 */
const ROOT = join(__dirname, '..', '..');

function read(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), 'utf8');
}

describe('поколение сессии согласовано в коде, миграции и бутстрапе', () => {
  const migration = read('lib', 'db', 'migrations', '0019_session_epoch.sql');
  const schema = read('lib', 'db', 'schema.ts');
  const bootstrap = read('scripts', 'bootstrap.sql');

  it('миграция аддитивная и с DEFAULT 0 — иначе ломаются существующие строки', () => {
    expect(migration).toMatch(/ALTER TABLE auth_user ADD COLUMN session_epoch/i);
    expect(migration).toMatch(/NOT NULL DEFAULT 0/i);
    // Дефолт 0 обязателен: счётчик начинается у всех одинаково, иначе первая же выдача
    // сессии после развёртывания разъехалась бы с уже выданными токенами.
    expect(migration).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
  });

  it('миграция объясняет, почему токены без поколения не принимаются', () => {
    // Обоснование живёт в файле миграции, а не в коммите: через полгода «почему всех
    // разлогинило» спрашивают у файла, а не у журнала git.
    expect(migration).toMatch(/миграци|разлогин/i);
  });

  it('схема Drizzle знает ту же колонку с тем же дефолтом', () => {
    expect(schema).toMatch(/sessionEpoch: integer\('session_epoch'\)\.notNull\(\)\.default\(0\)/);
  });

  it('чистая база получает ту же колонку (bootstrap.sql)', () => {
    // Без этого развёртывание с нуля падает на первой выдаче сессии: колонки нет.
    const authUserBlock = bootstrap.slice(
      bootstrap.indexOf('CREATE TABLE IF NOT EXISTS auth_user'),
      bootstrap.indexOf(';', bootstrap.indexOf('CREATE TABLE IF NOT EXISTS auth_user')),
    );
    expect(authUserBlock).toMatch(/session_epoch\s+INTEGER NOT NULL DEFAULT 0/i);
  });
});