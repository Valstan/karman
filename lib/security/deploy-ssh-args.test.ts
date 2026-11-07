import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Контроль к G321: значения деплоя едут на бокс переменными окружения, а не
 * позиционными аргументами `ssh`.
 *
 * Дефект: `ssh karman 'bash -s' "$SHA" "$BASE" …` НЕ передаёт argv. ssh склеивает
 * аргументы в одну командную строку, которую разбирает удалённый шелл. Пустой
 * аргумент при этом исчезает молча, значение с пробелом разъезжается на два, а `$`
 * внутри значения раскрывается на боксе. Сегодня это работает (все значения
 * непустые и без пробелов), но дефект живёт, и следующая правка `DEPLOY_BASE`
 * могла бы уехать на прод как тихая ошибка.
 *
 * Проверка живёт в CI (шаг `npm run test`), а не в голове агента: гейт, который
 * живёт только в памятке, гейтом не считается (#125, D-096).
 *
 * Проверка не «красная только у меня»: харнесс — тот же bash, что и в CI
 * (ubuntu-latest), и локально (Git Bash), а сам он читает строку построения
 * команды ИЗ workflow — то есть проверяет файл, который едет на прод (G552:
 * «красный гейт только у меня» — отдельный класс дефектов, и CI их не ловит
 * принципиально).
 */
const ROOT = join(__dirname, '..', '..');
const HARNESS = join(ROOT, 'scripts', 'tests', 'deploy_ssh_args.test.sh');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'deploy-prod.yml');

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

function workflow(): string {
  return readFileSync(WORKFLOW, 'utf8');
}

describe('G321: значения деплоя едут переменными окружения, а не argv', () => {
  it('харнесс на месте — гейт проверяет не пустоту', () => {
    expect(existsSync(HARNESS)).toBe(true);
    expect(existsSync(WORKFLOW)).toBe(true);
  });

  it('живой прогон: значения доходят целыми, старый способ — нет', () => {
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
      // трактует их как экранирование. Относительный путь одинаков на всех
      // платформах, а харнесс сам находит свою папку по `dirname -- "$0"`.
      out = execFileSync(bash as string, ['scripts/tests/deploy_ssh_args.test.sh'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
    } catch (err) {
      failed = true;
      const e = err as { stdout?: string; stderr?: string };
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(failed, `харнесс упал:\n${out}`).toBe(false);
    expect(out).toContain('deploy_ssh_args.test.sh: OK');
  }, 120_000);

  it('в workflow не осталось вызовов ssh с позиционными аргументами', () => {
    const yaml = workflow();
    // Каждый вызов `ssh karman 'bash -s'` обязан идти без аргументов: иначе это
    // ровно та склейка, из-за которой значение молча исчезает или рвётся.
    const legacy = [...yaml.matchAll(/ssh karman 'bash -s'([^\n]*)/g)].map((m) =>
      (m[1] ?? '').trim(),
    );
    for (const tail of legacy) {
      expect(tail, `вызов ssh с аргументами:\n${tail}`).toBe("2>/dev/null <<'REMOTE'");
    }
    // Оба места деплоя (выкатка сборки и смоук) — на переменных окружения.
    const envCalls = yaml.match(/ssh karman "\$DEPLOY_(SMOKE_)?SSH_CMD"/g) ?? [];
    expect(envCalls.length).toBe(2);
  });

  it('значения кодируются %q — удалённый шелл увидит ровно то, что послали', () => {
    const yaml = workflow();
    expect(yaml).toContain("printf '%q'");
    // Построение команды — отдельной строкой, чтобы её можно было проверить
    // отдельно от вызова ssh (харнесс читает именно её).
    expect(yaml).toMatch(/DEPLOY_SSH_CMD="SHA=/);
    expect(yaml).toMatch(/DEPLOY_SMOKE_SSH_CMD="PORT=/);
  });

  it('удалённый скрипт проверяет наличие каждого значения', () => {
    const yaml = workflow();
    // Молчаливая подстановка — ровно тот дефект, который чинится: значение,
    // которого нет, обязано ронять деплой громко.
    expect(yaml).toMatch(/for v in SHA BASE SHA256 TMPD; do/);
    expect(yaml).toContain('${!v}');
    expect(yaml).toContain('не дошла до бокса');
  });
});
