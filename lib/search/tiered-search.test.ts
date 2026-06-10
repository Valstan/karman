import { describe, expect, it } from 'vitest';
import {
  convertKeyboardLayout,
  damerauLevenshtein,
  rankMatches,
  searchMatch,
} from './tiered-search';

describe('searchMatch — уровни', () => {
  it('пустой запрос матчит всё без подсветки', () => {
    const m = searchMatch('   ', ['Ипотека']);
    expect(m.matched).toBe(true);
    expect(m.tier).toBeNull();
    expect(m.highlights).toEqual([]);
  });

  it('exact: полное совпадение поля', () => {
    expect(searchMatch('ипотека', ['Ипотека']).tier).toBe('exact');
  });

  it('prefix: начало строки', () => {
    expect(searchMatch('ипо', ['Ипотека Сбер']).tier).toBe('prefix');
  });

  it('word-prefix: начало слова внутри строки', () => {
    expect(searchMatch('сбер', ['Ипотека Сбер']).tier).toBe('word-prefix');
  });

  it('substring: середина слова (главный режим — НЕ prefix-only)', () => {
    const m = searchMatch('отек', ['Ипотека']);
    expect(m.tier).toBe('substring');
    expect(m.highlights[0]?.ranges).toEqual([[2, 6]]);
  });

  it('subsequence: символы по порядку с разрывами', () => {
    expect(searchMatch('иптк', ['Ипотека']).tier).toBe('subsequence');
  });

  it('пропущенная буква — это тоже subsequence (выше fuzzy)', () => {
    expect(searchMatch('ипотеа', ['Ипотека']).tier).toBe('subsequence');
  });

  it('fuzzy: опечатка-замена', () => {
    expect(searchMatch('ипатека', ['Ипотека']).tier).toBe('fuzzy');
  });

  it('fuzzy: перестановка соседних букв (транспозиция)', () => {
    expect(searchMatch('иптоека', ['Ипотека']).tier).toBe('fuzzy');
  });

  it('fuzzy: опечатка в начале длинного слова (префикс слова)', () => {
    expect(searchMatch('сбре', ['Сбербанк']).tier).toBe('fuzzy');
  });

  it('короткий токен (≤3) не фаззится — мусор отсечён', () => {
    expect(searchMatch('xyz', ['Ипотека']).matched).toBe(false);
  });

  it('не матчит произвольный беспорядок символов', () => {
    expect(searchMatch('акетопи-нет', ['Ипотека']).matched).toBe(false);
  });
});

describe('searchMatch — нормализация', () => {
  it('регистронезависимость и ё↔е', () => {
    expect(searchMatch('ЗАЁМ', ['заем потребительский']).tier).toBe('prefix');
    expect(searchMatch('заем', ['Заём']).tier).toBe('exact');
  });

  it('нормализация номеров: 2401 находит 240-1 и наоборот', () => {
    expect(searchMatch('2401', ['Договор 240-1']).matched).toBe(true);
    expect(searchMatch('240-1', ['Договор № 2401']).matched).toBe(true);
  });

  it('подсветка номера ложится на исходные символы с разделителем', () => {
    const m = searchMatch('2401', ['Договор 240-1']);
    // «240-1» в исходнике — позиции 8..13
    expect(m.highlights[0]?.ranges).toEqual([[8, 13]]);
  });

  it('последние цифры номера находятся (substring по цифрам)', () => {
    expect(searchMatch('40-1', ['Договор № 240-1']).matched).toBe(true);
  });
});

describe('searchMatch — многотокенность (AND)', () => {
  it('оба токена должны совпасть, порядок любой', () => {
    expect(searchMatch('сбер ипотека', ['Ипотека', 'Сбербанк']).matched).toBe(true);
    expect(searchMatch('втб ипотека', ['Ипотека', 'Сбербанк']).matched).toBe(false);
  });

  it('ранг — по худшему токену', () => {
    // «ипотека» — exact, «сбре» — fuzzy → итог fuzzy
    expect(searchMatch('ипотека сбре', ['Ипотека', 'Сбер']).tier).toBe('fuzzy');
  });

  it('токены могут совпадать в разных полях', () => {
    const m = searchMatch('паспорт 7788', ['Паспорт РФ', '45 77-88', 'МВД']);
    expect(m.matched).toBe(true);
    expect(m.highlights.map((h) => h.field)).toEqual([0, 1]);
  });
});

describe('rankMatches — ранжирование и раскладка', () => {
  const items = [
    { id: 1, name: 'Ипотека', bank: 'Сбербанк' },
    { id: 2, name: 'Автокредит', bank: 'ВТБ' },
    { id: 3, name: 'Кредит на ипотеку вторички', bank: 'Альфа' },
    { id: 4, name: 'Ипатека', bank: 'Дом.РФ' }, // опечатка в данных — ловится fuzzy
  ];
  const fields = (i: (typeof items)[number]) => [i.name, i.bank];

  it('пустой запрос возвращает всё в исходном порядке', () => {
    const r = rankMatches('', items, fields);
    expect(r.matches.map((m) => m.item.id)).toEqual([1, 2, 3, 4]);
  });

  it('точные/префиксные раньше substring; fuzzy — последними', () => {
    const r = rankMatches('ипотека', items, fields);
    const ids = r.matches.map((m) => m.item.id);
    expect(ids[0]).toBe(1); // exact
    // «ипотеку» (другая словоформа) и «Ипатека» (опечатка) — оба «похожие» (fuzzy)
    const fuzzyOnly = r.matches.filter((m) => m.isFuzzy).map((m) => m.item.id);
    expect(fuzzyOnly).toEqual([3, 4]);
    expect(ids).toEqual([1, 3, 4]); // ВТБ/Автокредит не матчится вовсе
  });

  it('RU↔EN: запрос в латинской раскладке находит русское', () => {
    // «ипотека» набранная в EN-раскладке
    const r = rankMatches(convertKeyboardLayout('ипотека'), items, fields);
    expect(r.layoutConverted).toBe(true);
    expect(r.matches[0]?.item.id).toBe(1);
  });

  it('нет результатов ни так, ни с конвертацией → пусто без флага', () => {
    const r = rankMatches('zzzzzz', items, fields);
    expect(r.matches).toEqual([]);
    expect(r.layoutConverted).toBe(false);
  });
});

describe('convertKeyboardLayout', () => {
  it('EN→RU', () => {
    expect(convertKeyboardLayout('bgjntrf')).toBe('ипотека');
  });
  it('RU→EN', () => {
    expect(convertKeyboardLayout('руддщ')).toBe('hello');
  });
});

describe('damerauLevenshtein', () => {
  it('считает замену/вставку/удаление/транспозицию', () => {
    expect(damerauLevenshtein('кот', 'кит', 2)).toBe(1);
    expect(damerauLevenshtein('кот', 'кто', 2)).toBe(1);
    expect(damerauLevenshtein('кот', 'котик', 2)).toBe(2);
    expect(damerauLevenshtein('кот', 'собака', 2)).toBeGreaterThan(2);
  });
});
