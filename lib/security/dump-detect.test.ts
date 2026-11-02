import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DUMP_COPY_PATTERN,
  DUMP_COPY_REGEX,
  DUMP_INSERT_PATTERN,
  DUMP_INSERT_REGEX,
  findDumpMarkers,
  VAULT_DUMP_TABLES,
} from './dump-detect';

/**
 * S4, аудит #057: «правила детекции дампа не работают» — не ловили ни
 * COPY-вывод `pg_dump`, ни `--column-inserts`. Причина была в форме: правила
 * искали значения полей, а дамп отдаёт их в другой форме.
 *
 * Гейт проверяет три вещи:
 * 1. детектор срабатывает на НАСТОЯЩЕМ виде выгрузки (COPY и --column-inserts);
 * 2. те же шаблоны лежат в `.gitleaks.toml` — иначе правило есть, а сканер его
 *    не применяет (ровно тот класс расхождения, что и был найден);
 * 3. `.gitignore` закрывает артефакты выгрузки — гейт без игнора ловит только
 *    то, что уже в индексе.
 */
const ROOT = join(__dirname, '..', '..');
const GITLEAKS = readFileSync(join(ROOT, '.gitleaks.toml'), 'utf8');
const GITIGNORE = readFileSync(join(ROOT, '.gitignore'), 'utf8');

/** Настоящий COPY-вывод pg_dump: заголовок + строки, разделённые табуляцией. */
const COPY_SAMPLE = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '',
  'SET statement_timeout = 0;',
  '',
  'COPY public.secrets_item (id, project_id, key, ciphertext, iv, "authTag", created_at, updated_at) FROM stdin;',
  '1\t19\tAPI_KEY\tY2lwaGVydGV4dA==\naXY=\taXRo\n\t2026-10-01 00:00:00+00\t2026-10-01 00:00:00+00',
  '\\.',
  '',
  'COPY public.secrets_token (id, project_id, name, token_prefix, token_hash, can_write, created_at, last_used_at, revoked_at) FROM stdin;',
  '7\t19\tself-serve\t0e3a\t9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\tf\t2026-10-04 16:15:25.473932+00\t\\N\t\\N',
  '\\.',
].join('\n');

/** Настоящий `--column-inserts`-вывод pg_dump. */
const INSERT_SAMPLE = [
  'SET statement_timeout = 0;',
  '',
  'INSERT INTO public.secrets_item (id, project_id, key, ciphertext, iv, "authTag", created_at, updated_at) VALUES (1, 19, \'API_KEY\', \'Y2lwaGVydGV4dA==\', \'aXY=\', \'aXRo\', \'2026-10-01 00:00:00+00\', \'2026-10-01 00:00:00+00\');',
  'INSERT INTO public.auth_totp (id, user_id, secret, confirmed_at) VALUES (3, 1, \'JBSWY3DPEHPK3PXP\', \'2026-09-01 10:00:00+00\');',
].join('\n');

describe('детектор дампа vault-таблиц (S4)', () => {
  it('ловит COPY-форму pg_dump', () => {
    expect(DUMP_COPY_REGEX.test(COPY_SAMPLE)).toBe(true);
    const markers = findDumpMarkers(COPY_SAMPLE);
    expect(markers.map((m) => m.table)).toContain('secrets_item');
    expect(markers.map((m) => m.table)).toContain('secrets_token');
    expect(markers.every((m) => m.form === 'copy')).toBe(true);
  });

  it('ловит --column-inserts-форму pg_dump', () => {
    expect(DUMP_INSERT_REGEX.test(INSERT_SAMPLE)).toBe(true);
    const markers = findDumpMarkers(INSERT_SAMPLE);
    expect(markers.map((m) => m.table)).toContain('secrets_item');
    expect(markers.map((m) => m.table)).toContain('auth_totp');
  });

  it('не ловит обычный SQL и собственные миграции (у них нет public.)', () => {
    const migration = [
      'INSERT INTO documents_document (title, document_type, user_id) VALUES (\'СНИЛС\', \'СНИЛС\', 1);',
      'INSERT INTO passport_issuer (issuer, jwks_uri) VALUES (\'https://issuer\', \'https://issuer/jwks\');',
      'INSERT INTO auth_user (username, password) VALUES (\'admin\', \'hash\');',
    ].join('\n');
    expect(findDumpMarkers(migration)).toEqual([]);
    expect(DUMP_COPY_REGEX.test(migration)).toBe(false);
    expect(DUMP_INSERT_REGEX.test(migration)).toBe(false);
  });

  it('не ловит посторонние таблицы', () => {
    expect(DUMP_COPY_REGEX.test('COPY public.reminder (id, title) FROM stdin;')).toBe(false);
    expect(DUMP_INSERT_REGEX.test('INSERT INTO public.credits_bank (id, name) VALUES (1, \'x\');')).toBe(
      false,
    );
  });

  it('те же шаблоны лежат в .gitleaks.toml — иначе сканер их не применяет', () => {
    expect(GITLEAKS).toContain(DUMP_COPY_PATTERN);
    expect(GITLEAKS).toContain(DUMP_INSERT_PATTERN);
    expect(GITLEAKS).toContain('karman-pgdump-copy-vault');
    expect(GITLEAKS).toContain('karman-pgdump-insert-vault');
  });

  it('.gitignore закрывает артефакты выгрузки', () => {
    for (const pattern of ['vault.sql', '*.dump', '*.tar']) {
      expect(GITIGNORE, `нет правила ${pattern}`).toContain(pattern);
    }
  });

  it('список таблиц совпадает с тем, что выгружает backup_vault.sh', () => {
    const script = readFileSync(join(ROOT, 'scripts', 'backup_vault.sh'), 'utf8');
    for (const table of VAULT_DUMP_TABLES) {
      expect(script, `таблица ${table} есть в дампе скрипта, но не в списке детектора`).toContain(
        `-t ${table}`,
      );
    }
  });
});
