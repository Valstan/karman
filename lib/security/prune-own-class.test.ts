import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Контроль к уборке своего класса (мандат brain 12.11, решение владельца 12.11).
 *
 * Опасность здесь ровно одна и она неочевидна: правило «оставь N свежих релизов
 * по mtime» без явного исключения симлинка `current` сносит ЖИВОЙ релиз, из
 * которого запущено приложение (G589). Второй класс — каталог, занятый
 * WorkingDirectory юнита или чужим cwd: такой тоже нельзя сносить.
 *
 * Проверка живёт в CI (шаг `npm run test`), а не в голове агента: гейт, который
 * живёт только в памятке, гейтом не считается (#125, D-096).
 *
 * Харнесс — тот же bash, что и в CI (ubuntu-latest) и локально (Git Bash), и
 * гоняет САМ скрипт на настоящих файлах в mktemp-каталоге, с подменёнными
 * DEPLOY_BASE / OWN_LOG_DIR.
 */
const ROOT = join(__dirname, '..', '..');
const HARNESS = join(ROOT, 'scripts', 'tests', 'prune_own_class.test.sh');
const SCRIPT = join(ROOT, 'scripts', 'prune_own_class.sh');

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

function script(): string {
  return readFileSync(SCRIPT, 'utf8');
}

describe('уборка своего класса: живой релиз не сносится (G589)', () => {
  it('харнесс и скрипт на месте — гейт проверяет не пустоту', () => {
    expect(existsSync(HARNESS)).toBe(true);
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('живой прогон: 7 сценариев уборки проходят', () => {
    const bash = findBash();
    expect(
      bash,
      'для прогона харнесса нужен bash: в CI он есть (ubuntu-latest), локально на Windows — Git Bash (C:/Program Files/Git/bin/bash.exe)',
    ).not.toBeNull();

    let out = '';
    let failed = false;
    try {
      // Путь к харнессу — POSIX-relative, от корня репозитория (cwd = ROOT):
      // абсолютный путь на Windows приезжает в bash с обратными слэшами, и bash
      // трактует их как экранирование.
      out = execFileSync(bash as string, ['scripts/tests/prune_own_class.test.sh'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
    } catch (err) {
      failed = true;
      const e = err as { stdout?: string; stderr?: string };
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(failed, `харнесс упал:\n${out}`).toBe(false);
    expect(out).toContain('prune_own_class.test.sh: OK');
  }, 120_000);

  it('симлинк `current` исключён из удаления по разрешённому пути', () => {
    const src = script();
    // Живой релиз опознаётся через `readlink -f` симлинка `current`, а не по
    // имени каталога: правило по имени сносит живой релиз, если его каталог
    // называется не как «ожидаемый».
    expect(src).toMatch(/readlink -f "\$BASE\/current"/);
    expect(src).toContain('ЖИВОЙ — не трогаю');
  });

  it('каталог, занятый процессом, не сносится', () => {
    const src = script();
    // WorkingDirectory юнита и cwd процессов (/proc/<pid>/cwd) — два способа
    // «релиз занят»; оба обязаны блокировать удаление.
    expect(src).toContain('WorkingDirectory');
    expect(src).toContain('/proc/[0-9]*');
    expect(src).toContain('занят процессом — не трогаю');
  });

  it('media/ (документы владельца) не трогается, логи обрезаются по TTL', () => {
    const src = script();
    // Документы — не кэш: удалять их нельзя ни при какой уборке.
    expect(src).not.toMatch(/rm -rf .*media/);
    // У логов наших есть порог: без него они растут вечно.
    expect(src).toContain('LOG_MAX_BYTES');
  });

  it('по умолчанию — dry-run: удаление только по явному --apply', () => {
    const src = script();
    expect(src).toContain('DRY_RUN=1');
    expect(src).toContain('--apply');
    expect(src).toContain('dry-run: ничего не удалено');
  });

  it('логи находятся и без $HOME/backups, а деплой передаёт базу явно', () => {
    const src = script();
    // Логин деплоя может отличаться от логина владельца: тогда $HOME/backups
    // не существует, а логи лежат рядом с базой. Без этой ветки скрипт отработал
    // бы вхолостую — и лог продолжил бы расти (тихий no-op).
    expect(src).toContain('dirname -- "$BASE"');
    expect(src).toContain('каталог логов не найден');
    // Деплой обязан отдать скрипту базу явно — иначе тот возьмёт $HOME/karman.
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'deploy-prod.yml'), 'utf8');
    expect(workflow).toContain('DEPLOY_BASE="$BASE" bash "$BASE/scripts/prune_own_class.sh" --apply --keep 5');
  });
});
