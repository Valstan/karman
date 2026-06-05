import { describe, it, expect } from 'vitest';
import { buildCsv, csvMoney, csvDate } from './csv';

const BOM = String.fromCharCode(0xfeff);

describe('buildCsv', () => {
  it('начинается с BOM и разделяет точкой с запятой, строки через CRLF', () => {
    const out = buildCsv(['A', 'B'], [['1', '2']]);
    expect(out.startsWith(BOM)).toBe(true);
    expect(out).toBe(`${BOM}A;B\r\n1;2\r\n`);
  });

  it('экранирует поля с разделителем, кавычкой и переводом строки', () => {
    const out = buildCsv(['H'], [['a;b'], ['c"d'], ['e\nf']]);
    const body = out.slice(BOM.length);
    expect(body).toBe('H\r\n"a;b"\r\n"c""d"\r\n"e\nf"\r\n');
  });

  it('null/undefined → пустое поле', () => {
    const out = buildCsv(['A', 'B'], [[null, undefined]]);
    expect(out).toBe(`${BOM}A;B\r\n;\r\n`);
  });

  it('числа сериализуются как есть', () => {
    const out = buildCsv(['N'], [[36]]);
    expect(out).toBe(`${BOM}N\r\n36\r\n`);
  });
});

describe('csvMoney', () => {
  it('точка → запятая, всегда два знака', () => {
    expect(csvMoney('1234.5')).toBe('1234,50');
    expect(csvMoney('300000.00')).toBe('300000,00');
    expect(csvMoney(18.5)).toBe('18,50');
  });

  it('пусто/нет/не число → ""', () => {
    expect(csvMoney(null)).toBe('');
    expect(csvMoney(undefined)).toBe('');
    expect(csvMoney('')).toBe('');
    expect(csvMoney('abc')).toBe('');
  });
});

describe('csvDate', () => {
  it('YYYY-MM-DD → DD.MM.YYYY', () => {
    expect(csvDate('2026-06-05')).toBe('05.06.2026');
  });

  it('пусто/нет → ""', () => {
    expect(csvDate(null)).toBe('');
    expect(csvDate(undefined)).toBe('');
  });
});
