import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * S5, аудит #057: секреты в argv.
 *
 * `psql "$DATABASE_URL"` и `pg_dump "$DATABASE_URL"` клали пароль роли в
 * /proc/<pid>/cmdline — а этот файл читает любой пользователь машины, а бокс
 * делится с соседями. Находка была в правке, поэтому и возврат возможен: правило
 * живёт в коде, но «кто-то снова написал $DATABASE_URL в psql» — это ровно тот
 * класс, который гейт и должен ловить, а не память Reviewer'а.
 *
 * Гейт проверяет не «как именно подключаться», а ЗАПРЕЩЁННОЕ:
 * - DSN с паролем в argv у psql/pg_dump;
 * - логин/пароль в argv у curl (`--user`).
 *
 * Секрет в окружении (`PGPASSFILE`, `netrc`) — не нарушение: /proc/<pid>/environ
 * читает только владелец процесса, в отличие от cmdline, который виден всем.
 */
const ROOT = join(__dirname, '..', '..');
const SCRIPTS_DIR = join(ROOT, 'scripts');

const scriptFiles = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.sh'));

describe('секреты не уходят в argv (S5)', () => {
  it('скрипты операций на месте — гейт проверяет не пустоту', () => {
    expect(scriptFiles.length).toBeGreaterThan(0);
    expect(scriptFiles).toContain('backup_vault.sh');
    expect(scriptFiles).toContain('health_watch.sh');
  });

  it.each(scriptFiles)('%s: DSN не передаётся в argv psql/pg_dump', (file) => {
    const src = readFileSync(join(SCRIPTS_DIR, file), 'utf8');
    const offenders = [...src.matchAll(/^\s*(?:psql|pg_dump)\b.*/gm)]
      .map((m) => m[0])
      .filter((line) => /"\$DATABASE_URL"|'\$DATABASE_URL'/.test(line));
    expect(offenders, `DSN с паролем в argv:\n${offenders.join('\n')}`).toEqual([]);
  });

  it.each(scriptFiles)('%s: логин/пароль не передаётся в argv curl', (file) => {
    const src = readFileSync(join(SCRIPTS_DIR, file), 'utf8');
    const offenders = [...src.matchAll(/^\s*curl\b.*/gm)]
      .map((m) => m[0])
      .filter((line) => /--user\s+"?\$/.test(line));
    expect(offenders, `учётка в argv:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('пароль роли уезжает в .pgpass, а не в argv', () => {
    const helper = readFileSync(join(SCRIPTS_DIR, 'pg-connect.sh'), 'utf8');
    expect(helper).toContain('pgpass');
    expect(helper).toContain('PG_DSN_NOPASS');
    // сам пароль в .pgpass пишется из разбора DSN, а не копируется в скрипт
    expect(helper).not.toMatch(/PASSWORD\s*=\s*["'][^"']+["']/);
  });
});
