import { describe, it, expect } from 'vitest';
import {
  absolutePathFor,
  buildRelPath,
  contentTypeForPath,
  extForMime,
  isImagePath,
  mediaRoot,
  safeDownloadName,
  sanitizeFileName,
} from './media-paths';

describe('extForMime', () => {
  it('возвращает расширение для разрешённых типов', () => {
    expect(extForMime('image/jpeg')).toBe('jpg');
    expect(extForMime('image/png')).toBe('png');
    expect(extForMime('image/webp')).toBe('webp');
    expect(extForMime('application/pdf')).toBe('pdf');
  });

  it('возвращает null для запрещённых типов', () => {
    expect(extForMime('image/gif')).toBeNull();
    expect(extForMime('application/zip')).toBeNull();
    expect(extForMime('')).toBeNull();
  });
});

describe('buildRelPath', () => {
  it('строит относительный путь со слешами posix', () => {
    expect(buildRelPath(3, 12, 'jpg', 'ab12cd34')).toBe('documents/3/12/ab12cd34.jpg');
  });

  it('укладывается в varchar(255) при реальных id и 16-символьном token', () => {
    const p = buildRelPath(999999, 999999, 'webp', 'a'.repeat(16));
    expect(p.length).toBeLessThanOrEqual(255);
  });
});

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

  it('снимает ведущие точки (скрытый файл) и схлопывает многоточия', () => {
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

describe('safeDownloadName', () => {
  it('берёт исходное имя, если оно пригодно', () => {
    expect(safeDownloadName('паспорт 2.jpg', 'Паспорт', 1, 'documents/1/2/ab.jpg')).toBe(
      'паспорт 2.jpg',
    );
  });

  it('подставляет имя документа с номером, если исходного нет', () => {
    expect(safeDownloadName('', 'Паспорт РФ', 0, 'documents/1/2/ab.jpg')).toBe('Паспорт РФ-1.jpg');
    expect(safeDownloadName('   ', 'Паспорт РФ', 2, 'documents/1/2/ab.pdf')).toBe(
      'Паспорт РФ-3.pdf',
    );
  });

  it('не отдаёт наружу имя, состоящее из одних запрещённых символов', () => {
    expect(safeDownloadName('///', 'Полис', 0, 'documents/1/2/ab.png')).toBe('Полис-1.png');
  });

  it('падает на запасное имя, если исходное чрезмерно длинное', () => {
    const long = `${'я'.repeat(200)}.jpg`;
    expect(safeDownloadName(long, 'Диплом', 0, 'documents/1/2/ab.jpg')).toBe('Диплом-1.jpg');
  });

  it('без расширения в пути даёт bin, а не пустой хвост', () => {
    expect(safeDownloadName('', 'Справка', 0, 'documents/1/2/ab')).toBe('Справка-1.bin');
  });
});

describe('absolutePathFor', () => {
  it('разрешает нормальный относительный путь', () => {
    const abs = absolutePathFor('documents/1/2/front-x.jpg');
    expect(abs.startsWith(mediaRoot())).toBe(true);
  });

  it('блокирует обход каталога', () => {
    expect(() => absolutePathFor('../../../etc/passwd')).toThrow();
    expect(() => absolutePathFor('documents/../../secret')).toThrow();
  });

  it('блокирует абсолютный путь', () => {
    expect(() => absolutePathFor('/etc/passwd')).toThrow();
  });
});

describe('isImagePath', () => {
  it('распознаёт растровые изображения', () => {
    expect(isImagePath('documents/1/2/front-x.jpg')).toBe(true);
    expect(isImagePath('documents/1/2/front-x.jpeg')).toBe(true);
    expect(isImagePath('documents/1/2/front-x.png')).toBe(true);
    expect(isImagePath('documents/1/2/front-x.webp')).toBe(true);
    expect(isImagePath('FRONT-X.PNG')).toBe(true);
  });

  it('PDF и прочее — не изображение', () => {
    expect(isImagePath('documents/1/2/additional-x.pdf')).toBe(false);
    expect(isImagePath('documents/1/2/front-x.bin')).toBe(false);
    expect(isImagePath('noext')).toBe(false);
  });
});

describe('contentTypeForPath', () => {
  it('определяет content-type по расширению', () => {
    expect(contentTypeForPath('a/b/front-x.jpg')).toBe('image/jpeg');
    expect(contentTypeForPath('a/b/front-x.png')).toBe('image/png');
    expect(contentTypeForPath('a/b/front-x.webp')).toBe('image/webp');
    expect(contentTypeForPath('a/b/front-x.pdf')).toBe('application/pdf');
    expect(contentTypeForPath('a/b/front-x.bin')).toBe('application/octet-stream');
  });
});
