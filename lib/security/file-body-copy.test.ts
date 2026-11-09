import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Гейт «тело файла отдаётся без второй копии» (аудит #057, D6).
 *
 * Находка была такой: `readFile` отдаёт `Buffer` (подтип `Uint8Array`), а обёртка
 * `new Uint8Array(buffer)` копировала файл ВТОРЫМ разом. На лимите в 10 МБ это две
 * копии в памяти сервера на каждый отдаваемый файл — при параллельной разгрузке
 * («Поделиться картинкой», ZIP-выгрузка круга) это уже не «лишний мегабайт».
 *
 * Почему гейт, а не разовая правка: обёртка выглядит безобидно (`new Uint8Array(x)`
 * — обычный приём), и её легко вернуть при следующей правке роута. Класс дефекта —
 * «намерение есть, проверки нет»: ровно тот, что гейт `docs/write-paths.md` уже
 * ловит для путей записи.
 *
 * Намеренно НЕ проверяем, что файл вообще читается и что права выдачи верны: это
 * читается глазами и проверяется состязательным аудитом. Здесь ловится только
 * лишняя копия.
 */

const ROOT = join(__dirname, '..', '..');

function walk(dir: string, filter: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, filter));
    } else if (filter(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Исходник без комментариев: иначе гейт ловит собственное объяснение рядом
 * с исправлением (в комментарии законно назвать запрещённую форму — она именно
 * там и объясняется).
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Роуты под `app/api`, которые отдают тело файла (не JSON, не поток). */
function fileServingRoutes(): string[] {
  const dir = join(ROOT, 'app', 'api');
  return walk(dir, (name) => name === 'route.ts')
    .map((file) => relative(dir, file).split(sep).join('/'))
    .filter((rel) => {
      const source = readFileSync(join(dir, rel), 'utf8');
      return /readFile\(/.test(source);
    });
}

describe('тело файла отдаётся без лишней копии', () => {
  it('роуты, отдающие файл, найдены (гейт не молчит вхолостую)', () => {
    const routes = fileServingRoutes();
    expect(routes.length, 'роутов, отдающих файл').toBeGreaterThan(0);
    expect(routes.join(' ')).toMatch(/files/);
  });

  it('в файловых роутах нет обёртки new Uint8Array(buffer)', () => {
    const dir = join(ROOT, 'app', 'api');
    const offenders: string[] = [];
    for (const rel of fileServingRoutes()) {
      const source = stripComments(readFileSync(join(dir, rel), 'utf8'));
      if (/new Uint8Array\(\s*buffer\s*\)/.test(source)) offenders.push(rel);
    }
    expect(offenders, 'файловые роуты с лишней копией тела').toEqual([]);
  });

  it('отдаваемое тело — сам Buffer, а не его копия (негативный контроль)', () => {
    // Гейт, который нельзя уронить, — не гейт. Синтетический роут повторяет форму
    // реальных: первый отдаёт Buffer, второй оборачивает его в копию.
    const offenders = (source: string): boolean =>
      /new Uint8Array\(\s*buffer\s*\)/.test(source);

    expect(offenders('const buffer = await readFile(p);\nreturn new NextResponse(buffer, {});')).toBe(false);
    expect(offenders('const buffer = await readFile(p);\nreturn new NextResponse(new Uint8Array(buffer), {});')).toBe(
      true,
    );
  });
});
