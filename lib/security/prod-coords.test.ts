import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * C5, аудит #057: D-038 жил прозой — «координаты прода не должны попадать в
 * отслеживаемые файлы» было правилом в каноне, а не гейтом. Правило, которое
 * нельзя случайно нарушить, — это не правило.
 *
 * Гейт ловит СТРУКТУРНЫЕ классы координат, а не конкретные строки:
 *
 * 1. **IDN-домен** — наш домен кириллический, в коде он живёт в punycode
 *    (`xn--…`). Такая строка в отслеживаемом файле — координата.
 * 2. **Системный логин в пути** — `/home/<логин>/…` раскрывает и пользователя,
 *    и раскладку машины.
 * 3. **Публичный IPv4** — адрес боевого или соседнего хоста.
 *
 * Честная граница (она же — граница самой D-038): ЧИСТО ASCII-FQDN вида
 * `host.example.tld` гейт не ловит. Список «разрешённых» сторонних доменов
 * (telegram, yandex, github) разрастается быстрее, чем список запрещённых, и
 * такой список сам становится источником правды о том, куда мы ходим.
 * Имя боевого хоста уже опубликовано в переписке — владелец сознательно решил
 * её не переписывать (25.08), и новый гейт не может это отменить. Ловится
 * главное: IDN-домен (он же главный секрет экосистемы), логин и IP.
 *
 * Переписка (`mailbox/`) и архив закрытых пунктов (`docs/pending-archive/`)
 * исключены: это ИСТОРИЯ, а не текущие файлы, и владелец 25.08 прямо попросил
 * её не трогать. Всё остальное — под гейтом.
 */
const ROOT = join(__dirname, '..', '..');

/** Пути, которые гейт не смотрит (история, а не текущие файлы). */
const EXEMPT_PREFIXES = ['mailbox/', 'docs/pending-archive/'];

/**
 * Отдельные файлы — с записанной причиной. Исключение видно в diff'е и
 * пересматривается, а не прячется в списке молча.
 */
const EXEMPT_FILES: Record<string, string> = {
  'lib/auth/oidc.test.ts':
    'фикстуры punycode: проверка побайтового прогона redirect_uri. Домен в фикстуре — ' +
    'не наш боевой, но это IDN-домен, и по форме он от гейта неотличим.',
};

/** Файлы больше мегабайта читать не нужно — координаты в бинарнике не живут. */
const MAX_BYTES = 1024 * 1024;

type Rule = { id: string; what: string; pattern: RegExp; skip?: (match: RegExpExecArray) => boolean };

const RULES: Rule[] = [
  {
    id: 'idn-domain',
    what: 'домен в punycode (xn--…)',
    pattern: /\bxn--[a-z0-9]{2,}(?:\.[a-z0-9-]+)+\.[a-z]{2,}/gi,
  },
  {
    id: 'idn-domain-cyrillic',
    what: 'кириллический домен',
    // Последний ярлык обязан быть настоящим TLD: иначе под правило попадает
    // русская проза с точкой («Яндекс.Диск», «токен.вовсе»). Список TLD
    // ограничен: наш домен кириллический, и его .рф/.ру в списке.
    pattern:
      /[а-яё]{2,}(?:\.[а-яё]{2,})*\.(?:рф|ру|su|com|net|org|io|app|co|me|info|biz|xyz|мск|дети|ик|онлайн|site|tech|cloud)\b/gi,
  },
  {
    id: 'home-login-path',
    what: 'системный логин в пути (/home/<логин>/…)',
    // Плейсхолдеры вида /home/<user>/ и /home/$USER/ под правило не попадают:
    // первый начинается с «<», второй — с «$».
    pattern: /\/home\/[a-z_][a-z0-9_-]*\//gi,
  },
  {
    id: 'public-ipv4',
    what: 'публичный IPv4-адрес',
    pattern: /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g,
    skip: (m) => {
      const [a, b] = [Number(m[1]), Number(m[2])];
      if (a === 127) return true; // loopback
      if (a === 10) return true; // частная
      if (a === 192 && b === 168) return true; // частная
      if (a === 172 && b >= 16 && b <= 31) return true; // частная
      if (a === 0) return true;
      if (m[0]!.endsWith('.0')) return true;
      // RFC 5737 — диапазоны для документации: правильные адреса для примеров.
      if (a === 192 && b === 0 && Number(m[3]) === 2) return true;
      if (a === 198 && b === 51 && Number(m[3]) === 100) return true;
      if (a === 203 && b === 0 && Number(m[3]) === 113) return true;
      return false;
    },
  },
];

/** Отслеживаемые файлы (git — источник истины про «отслеживается»). */
function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

describe('в отслеживаемых файлах нет координат прода (D-038, C5)', () => {
  const files = trackedFiles();
  const scanned = files.filter(
    (f) =>
      !EXEMPT_PREFIXES.some((p) => f.startsWith(p)) &&
      !(f in EXEMPT_FILES) &&
      statSync(join(ROOT, f)).size < MAX_BYTES,
  );

  it('список файлов разбирается — гейт проверяет не пустоту', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(scanned.length).toBeGreaterThan(50);
  });

  it('координат в отслеживаемых файлах нет', () => {
    const hits: string[] = [];
    for (const file of scanned) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const rule of RULES) {
        for (const match of text.matchAll(rule.pattern)) {
          if (rule.skip?.(match)) continue;
          const line = text.slice(0, match.index).split('\n').length;
          hits.push(`${file}:${line} [${rule.id}] ${rule.what}: ${match[0]}`);
        }
      }
    }
    expect(
      hits,
      'Координаты прода в отслеживаемых файлах. D-038: замени на плейсхолдер или ' +
        'вынеси в secrets/repo-vars. Исключения — только списком в EXEMPT_PREFIXES ' +
        'и с записанной причиной.',
    ).toEqual([]);
  });
});
