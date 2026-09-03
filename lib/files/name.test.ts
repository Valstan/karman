import { describe, expect, it } from 'vitest';
import { sanitizeFileName, uniqueFileName } from './name';

describe('sanitizeFileName', () => {
  it('оставляет читаемое имя как есть — пробелы и дефисы значимы', () => {
    expect(sanitizeFileName('паспорт разворот 2.jpg')).toBe('паспорт разворот 2.jpg');
    expect(sanitizeFileName('скан-1.pdf')).toBe('скан-1.pdf');
  });

  it('вырезает разделители пути — иначе имя записи в ZIP уводит распаковку', () => {
    // Разделители убираются, `....` схлопывается в точку, а она как ведущая
    // снимается — от обхода каталога не остаётся даже скрытого файла.
    expect(sanitizeFileName('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeFileName('a/b\\c.jpg')).toBe('abc.jpg');
  });

  it('снимает ведущие точки и схлопывает многоточия', () => {
    expect(sanitizeFileName('...hidden.jpg')).toBe('hidden.jpg');
    expect(sanitizeFileName('a..b.jpg')).toBe('a.b.jpg');
  });

  it('вырезает символы, запрещённые в именах файлов', () => {
    expect(sanitizeFileName('от 12:30 <копия>?.jpg')).toBe('от 1230 копия.jpg');
  });

  it('пустое остаётся пустым', () => {
    expect(sanitizeFileName('   ')).toBe('');
  });
});

describe('uniqueFileName', () => {
  it('первое имя проходит как есть', () => {
    const used = new Set<string>();
    expect(uniqueFileName('паспорт.jpg', used)).toBe('паспорт.jpg');
  });

  it('повтор получает номер ПЕРЕД расширением, а не в конце', () => {
    // «паспорт.jpg (2)» открывалось бы не тем приложением.
    const used = new Set<string>();
    uniqueFileName('паспорт.jpg', used);
    expect(uniqueFileName('паспорт.jpg', used)).toBe('паспорт (2).jpg');
    expect(uniqueFileName('паспорт.jpg', used)).toBe('паспорт (3).jpg');
  });

  it('имя без расширения тоже разводится', () => {
    const used = new Set<string>();
    uniqueFileName('скан', used);
    expect(uniqueFileName('скан', used)).toBe('скан (2)');
  });

  it('не путает уже занятое имя с суффиксом', () => {
    const used = new Set<string>(['п.jpg', 'п (2).jpg']);
    expect(uniqueFileName('п.jpg', used)).toBe('п (3).jpg');
  });

  it('разные имена друг другу не мешают', () => {
    const used = new Set<string>();
    expect(uniqueFileName('a.jpg', used)).toBe('a.jpg');
    expect(uniqueFileName('b.jpg', used)).toBe('b.jpg');
  });
});
