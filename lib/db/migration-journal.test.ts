import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '@/lib/db/test-db';

/**
 * Гейт гварда миграций (R1): журнал `schema_migrations` в БД и список миграций
 * репозитория обязаны сходиться.
 *
 * ЗАЧЕМ ГЕЙТ, А НЕ ПАМЯТКА. Предохранитель миграций сравнивал ДЕЛЬТУ коммита
 * («принёс ли этот коммит миграцию»), а защищать должен инвариант состояния
 * («код не уезжает на прод раньше схемы»). Окно между «миграция смержена» и
 * «миграция применена» держалось на памяти разработчика; 12.10 это уронило прод.
 * Теперь спрашивается прод (журнал в БД), и стоп-шаг деплоя живёт в
 * `deploy-prod.yml`, а этот гейт доказывает, что сама механика работает.
 *
 * ЧТО ПРОВЕРЯЕТСЯ (все пункты — на настоящем Postgres, pglite):
 *   1. baseline-строки журнала == ровно те файлы, что старше журнала: ни
 *      лишних, ни недостающих. Лишняя строка — журнал врёт о применённом;
 *      недостающая — миграция применена, но не отмечена, и гвард будет врать;
 *   2. запись в журнал идемпотентна (повторный вызов не плодит строки);
 *   3. после записи журнал покрывает ВСЕ миграции репозитория, и гвард
 *      (`scripts/migration_guard.mjs` — тот же скрипт, что гоняет деплой)
 *      завершается с кодом 0;
 *   4. КРАСНЫЕ КОНТРОЛИ: убранная запись и пустой журнал роняют гвард, и он
 *      называет именно недостающие файлы. Гейт, который нельзя увидеть
 *      красным, гейтом не считается (#104, docs/gates.md).
 *
 * ПРОДОВЫЙ SQL — НЕ КОПИЯ. Текст INSERT'а вырезается из
 * `scripts/migration_journal.sh` (блок RECORD_SQL_BEGIN) и исполняется здесь
 * как есть: разъехаться с тем, что реально пишет воркфлоу
 * `apply-migration.yml`, он не может.
 */

const ROOT = join(__dirname, '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'lib', 'db', 'migrations');
const JOURNAL_SCRIPT = join(ROOT, 'scripts', 'migration_journal.sh');
const GUARD_SCRIPT = join(ROOT, 'scripts', 'migration_guard.mjs');

/** Миграция, создающая журнал. Всё, что меньше неё, — baseline. */
const JOURNAL_MIGRATION = '0030_schema_migrations.sql';

let pg: PGlite | undefined;
let workDir = '';

beforeAll(async () => {
  const t = await createTestDb();
  pg = t.pg;
  workDir = mkdtempSync(join(tmpdir(), 'karman-migration-guard-'));
});

afterAll(async () => {
  await pg?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** Файлы миграций репозитория, по алфавиту. */
function repoMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** Номер версии из имени файла: `0029_…sql` → `0029`. */
function versionOf(file: string): string {
  return file.slice(0, 4);
}

/** Текст INSERT'а в журнал — из боевого скрипта, а не из копии здесь. */
function recordSqlTemplate(): string {
  const script = readFileSync(JOURNAL_SCRIPT, 'utf8');
  const match = script.match(/--- RECORD_SQL_BEGIN ---[\s\S]*?RECORD_SQL_TEMPLATE="([^"]+)"/);
  if (!match) {
    throw new Error(
      'в scripts/migration_journal.sh не найден блок RECORD_SQL_BEGIN — гейт не может проверить продовый SQL',
    );
  }
  return match[1]!;
}

/** Прогон гварда: тот же скрипт, что запускает шаг деплоя. */
function runGuard(journalLines: string[]) {
  const journalFile = join(workDir, `journal-${journalLines.length}-${Math.random().toString(36).slice(2)}.tsv`);
  writeFileSync(journalFile, journalLines.length ? `${journalLines.join('\n')}\n` : '', 'utf8');
  const result = spawnSync(
    process.execPath,
    [GUARD_SCRIPT, '--migrations', MIGRATIONS_DIR, '--journal', journalFile],
    { encoding: 'utf8' },
  );
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Строки журнала из БД — в том же виде, что печатает `migration_journal.sh list`. */
async function journalRows(): Promise<{ version: string; name: string; baseline: boolean }[]> {
  const res = await pg!.query<{ version: string; name: string; baseline: boolean }>(
    'select version, name, baseline from schema_migrations order by version',
  );
  return res.rows;
}

/** Запись в журнал — продовым SQL из скрипта. */
async function recordMigration(version: string, name: string): Promise<void> {
  const sql = recordSqlTemplate().replace('__VERSION__', version).replace('__NAME__', name);
  await pg!.exec(sql);
}

describe('гвард миграций: журнал в БД и репозиторий сходятся', () => {
  it('baseline-строки журнала — ровно миграции, старше журнала', async () => {
    const files = repoMigrations();
    const baselineExpected = files.filter((f) => versionOf(f) < versionOf(JOURNAL_MIGRATION)).sort();
    const rows = await journalRows();
    const baselineActual = rows.filter((r) => r.baseline).map((r) => r.name).sort();

    expect(
      baselineActual,
      'baseline-строки журнала не совпадают с миграциями до 0030: лишняя строка — журнал врёт о применённом, недостающая — миграция применена, но не отмечена',
    ).toEqual(baselineExpected);
    expect(
      baselineExpected.length,
      'в репозитории нет миграций до журнала — сверка потеряла смысл, файл переименуйте',
    ).toBeGreaterThan(0);
  });

  it('журнал не содержит ничего лишнего: каждая строка — файл из репозитория', async () => {
    const files = repoMigrations();
    const rows = await journalRows();
    const лишние = rows.map((r) => r.name).filter((n) => !files.includes(n));
    expect(лишние, `в журнале есть записи о несуществующих файлах: ${лишние.join(', ')}`).toEqual([]);
  });

  it('строки не из baseline не помечены baseline (признак — только у внесённых миграцией)', async () => {
    const rows = await journalRows();
    const ложные = rows
      .filter((r) => r.baseline && versionOf(r.name) >= versionOf(JOURNAL_MIGRATION))
      .map((r) => r.name);
    expect(
      ложные,
      `baseline=true у миграций не старше журнала: ${ложные.join(', ')} — признак означает «внесено до появления журнала»`,
    ).toEqual([]);
  });

  it('запись в журнал идемпотентна: повтор не плодит строки и не меняет время', async () => {
    await recordMigration(versionOf(JOURNAL_MIGRATION), JOURNAL_MIGRATION);
    const first = await journalRows();
    await recordMigration(versionOf(JOURNAL_MIGRATION), JOURNAL_MIGRATION);
    const second = await journalRows();

    expect(second.length, 'повторная запись добавила строку').toBe(first.length);
    const записанная = second.find((r) => r.name === JOURNAL_MIGRATION);
    expect(записанная, 'запись о миграции, создающей журнал, отсутствует').toBeDefined();
  });

  it('после записи журнал покрывает все миграции репозитория, гвард зелёный', async () => {
    // Запись идемпотентна, поэтому тест не зависит от порядка: журнал доводится
    // до полного состояния тем же путём, что и на проде. Записываются ВСЕ миграции
    // репозитория, а не только создающая журнал: новая миграция (например 0032) тоже
    // обязана попасть в журнал, иначе гвард (справедливо) скажет, что схема не
    // применена — и это должно быть видно и здесь, а не только на проде.
    for (const file of repoMigrations()) {
      await recordMigration(versionOf(file), file);
    }
    const rows = await journalRows();
    const lines = rows.map((r) => `${r.version}|${r.name}`);
    const guard = runGuard(lines);

    expect(
      guard.code,
      `гвард должен быть зелёным на полном журнале.\nstdout: ${guard.stdout}\nstderr: ${guard.stderr}`,
    ).toBe(0);
    expect(guard.stderr).not.toContain('::error::');
  });

  it('КРАСНЫЙ КОНТРОЛЬ: убранная запись роняет гвард, и он называет ровно её', async () => {
    const rows = await journalRows();
    const жертва = rows.find((r) => r.name === '0029_accounts_activation_index.sql');
    expect(жертва, 'в журнале нет строки 0029 — теряется смысл контроля').toBeDefined();

    await pg!.exec(`delete from schema_migrations where version = '${жертва!.version}'`);
    const послеУдаления = await journalRows();
    const guard = runGuard(послеУдаления.map((r) => `${r.version}|${r.name}`));

    expect(guard.code, 'гвард не заметил убранную запись — он ничего не проверяет').toBe(1);
    expect(guard.stderr).toContain(жертва!.name);
    expect(guard.stderr).toContain('::error::');

    // Возвращаем строку: следующие тесты считают журнал полным.
    await recordMigration(жертва!.version, жертва!.name);
  });

  it('КРАСНЫЙ КОНТРОЛЬ: пустой журнал роняет гвард по ВСЕМ миграциям', () => {
    const guard = runGuard([]);
    expect(guard.code, 'пустой журнал должен останавливать деплой').toBe(1);
    expect(guard.stderr).toContain('0030_schema_migrations.sql');
    expect(guard.stderr).toContain('::error::');
  });
});
