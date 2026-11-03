import { describe, expect, it } from 'vitest';
import { defaultAccountTitle, parseAccountImport } from '@/lib/accounts/import';

describe('мультиаккаунт: разбор списка для импорта', () => {
  it('строка «почта|пароль» — название по умолчанию имя ящика', () => {
    const { items, errors } = parseAccountImport('valstan@valstan.ru|Nitro@1941');
    expect(errors).toEqual([]);
    expect(items).toEqual([{ email: 'valstan@valstan.ru', password: 'Nitro@1941' }]);
    expect(defaultAccountTitle('valstan@valstan.ru')).toBe('valstan');
    expect(defaultAccountTitle('1@id45d.myjino.ru')).toBe('1');
  });

  it('название можно задать третьим полем', () => {
    const { items } = parseAccountImport('a@b.ru|pwd|Матрица РМЗ');
    expect(items[0]).toEqual({ email: 'a@b.ru', password: 'pwd', title: 'Матрица РМЗ' });
  });

  it('пустые строки и комментарии пропускаются', () => {
    const { items, errors } = parseAccountImport(['# список', '', 'a@b.ru|pwd', '   '].join('\n'));
    expect(items.length).toBe(1);
    expect(errors).toEqual([]);
  });

  it('плохая строка не роняет импорт, а попадает в ошибки с номером строки', () => {
    const { items, errors } = parseAccountImport(['a@b.ru|pwd', 'мусор', 'c@d.ru|pwd2'].join('\n'));
    expect(items.map((i) => i.email)).toEqual(['a@b.ru', 'c@d.ru']);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('строка 2');
  });

  it('пустая почта или пароль — ошибка', () => {
    const { items, errors } = parseAccountImport('a@b.ru|');
    expect(items.length).toBe(0);
    expect(errors.length).toBe(1);
  });

  it('пароль может содержать символы «|» только если он последний в строке', () => {
    // Разделитель — «|», поэтому пароль с «|» внутри не разобрать: это осознанное
    // ограничение формата (владелец вставляет пароли без «|»).
    const { items } = parseAccountImport('a@b.ru|pa|ss|word');
    expect(items[0]).toEqual({ email: 'a@b.ru', password: 'pa', title: 'ss' });
  });

  it('пятьдесят строк разбираются целиком', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `box${i}@example.test|pass${i}`);
    const { items, errors } = parseAccountImport(lines.join('\n'));
    expect(items.length).toBe(50);
    expect(errors).toEqual([]);
  });
});
