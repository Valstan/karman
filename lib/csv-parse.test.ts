import { describe, it, expect } from 'vitest';
import { parseCsv, detectDelimiter } from './csv-parse';

describe('detectDelimiter', () => {
  it('запятая (браузерный экспорт)', () => {
    expect(detectDelimiter('name,url,username,password')).toBe(',');
  });
  it('точка с запятой (ru-Excel)', () => {
    expect(detectDelimiter('имя;значение;описание')).toBe(';');
  });
  it('разделитель внутри кавычек не считается', () => {
    expect(detectDelimiter('"a,b,c";d')).toBe(';');
  });
});

describe('parseCsv', () => {
  it('простые строки', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('кавычки: разделитель и перевод строки внутри поля', () => {
    const csv = 'name,note\n"Acme, Inc.","line1\nline2"';
    expect(parseCsv(csv)).toEqual([
      ['name', 'note'],
      ['Acme, Inc.', 'line1\nline2'],
    ]);
  });

  it('удвоенные кавычки → одна', () => {
    expect(parseCsv('a\n"He said ""hi"""')).toEqual([['a'], ['He said "hi"']]);
  });

  it('CRLF и ведущий BOM', () => {
    expect(parseCsv('﻿a;b\r\n1;2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('пустые строки пропускаются', () => {
    expect(parseCsv('a,b\n\n1,2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('хвост без завершающего перевода строки', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('пустые поля сохраняются', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
  });
});
