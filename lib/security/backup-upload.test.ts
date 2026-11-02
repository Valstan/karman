import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * P1 (02.11): ночной бэкап vault 23 ночи не доезжал (09.10 — 31.10), а сторож
 * был зелёным. Причина — две, и обе в коде:
 *
 *   1. Сверка размера выгрузки была НЕДОСТИЖИМА: `wd -T` под `set -euo pipefail`
 *      ронял скрипт ДО строки сверки. Ровно тот случай, ради которого сверка и
 *      написана (обрыв на середине даёт «существующий» бэкап вплоть до дня
 *      восстановления), обрывал саму сверку.
 *   2. Сторож смотрел «свежесть лога», а лог писался каждую ночь ДО выгрузки.
 *      То есть «бэкап был» на практике означало «скрипт запускался».
 *
 * Первая часть чинится и проверяется БЕЗ бокса и без Диска: логика выгрузки
 * вынесена в scripts/backup_upload.sh и прогоняется харнессом с подставным
 * curl. Вторая — статикой: сторож обязан смотреть подтверждение выгрузки
 * (backup-ok-*), а не только лог.
 *
 * Проверка живёт в CI (шаг `npm run test`), а не в голове агента: гейт, который
 * живёт только в памятке, гейтом не считается (#125, D-096).
 */
const ROOT = join(__dirname, '..', '..');
const SCRIPTS_DIR = join(ROOT, 'scripts');
const HARNESS = join(SCRIPTS_DIR, 'tests', 'backup_upload.test.sh');

/** Ищем bash: CI — ubuntu-latest, локально на Windows — Git Bash. */
function findBash(): string | null {
  const candidates = [
    process.env.BASH_PATH,
    'bash',
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files/Git/usr/bin/bash.exe',
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // кандидат не подошёл — пробуем следующий
    }
  }
  return null;
}

describe('выгрузка бэкапа: сверка размера не теряется (P1, 02.11)', () => {
  it('харнесс на месте — гейт проверяет не пустоту', () => {
    expect(existsSync(HARNESS)).toBe(true);
    expect(existsSync(join(SCRIPTS_DIR, 'backup_upload.sh'))).toBe(true);
  });

  it('все сценарии выгрузки подтверждены харнессом', () => {
    const bash = findBash();
    expect(
      bash,
      'для прогона харнесса нужен bash: в CI он есть (ubuntu-latest), локально на Windows — Git Bash (C:/Program Files/Git/bin/bash.exe)',
    ).not.toBeNull();

    let out = '';
    let failed = false;
    try {
      out = execFileSync(bash as string, [HARNESS], { cwd: ROOT, encoding: 'utf8' });
    } catch (err) {
      failed = true;
      const e = err as { stdout?: string; stderr?: string };
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(failed, `харнесс упал:\n${out}`).toBe(false);
    expect(out).toContain('backup_upload.test.sh: OK');
  }, 120_000);

  it('backup_vault.sh выгружает через помощник, а не напрямую', () => {
    const src = readFileSync(join(SCRIPTS_DIR, 'backup_vault.sh'), 'utf8');
    expect(src).toContain('backup_upload.sh');
    // Прямой PUT в скрипте означал бы, что сверка снова осталась под `set -e`
    // недостижимой: убитый curl роняет скрипт, и сверка не выполняется.
    const directPuts = [...src.matchAll(/^\s*wd\s+-T\b.*$/gm)].map((m) => m[0]);
    expect(directPuts, `прямой вызов wd -T в backup_vault.sh:\n${directPuts.join('\n')}`).toEqual([]);
    expect(src).toContain('backup_upload_archive');
  });

  it('помощник сверяет размер ВСЕГДА, а не только после успешного кода curl', () => {
    const src = readFileSync(join(SCRIPTS_DIR, 'backup_upload.sh'), 'utf8');
    // Порядок «PUT → затем ВСЕГДА сверка»: код возврата клиента не решает,
    // решает размер на Диске.
    const putAt = src.indexOf('"$wd_fn" -T "$file" "$url"');
    const checkAt = src.indexOf('backup_remote_bytes "$url" "$wd_fn"');
    expect(putAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(putAt);
    expect(src).toContain('backup_wait_for_size');
    // При неудаче helper обязан оставить локальную копию: сейчас архив
    // удаляется вместе с временным каталогом, и обрыв уничтожает единственный
    // экземпляр файла.
    expect(src).toContain('keep_dir');
    expect(src).toContain('cp -f');
  });

  it('сторож смотрит подтверждение выгрузки, а не только свежесть лога', () => {
    const src = readFileSync(join(SCRIPTS_DIR, 'health_watch.sh'), 'utf8');
    expect(src).toContain('backup-ok-');
    expect(src).toContain('backup-run-');
    // Признак «бэкап был» обязан опираться на подтверждение размера.
    expect(src).toContain('НЕ подтверждён');
  });

  it('скрипт бэкапа оставляет отметки запуска и подтверждения', () => {
    const src = readFileSync(join(SCRIPTS_DIR, 'backup_vault.sh'), 'utf8');
    expect(src).toContain('backup-run-');
    expect(src).toContain('backup-ok-');
  });
});
