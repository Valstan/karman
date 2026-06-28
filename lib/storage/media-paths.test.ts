import { describe, it, expect } from 'vitest';
import {
  absolutePathFor,
  buildRelPath,
  contentTypeForPath,
  extForMime,
  isDocumentFileSlot,
  isImagePath,
  mediaRoot,
  SLOT_TO_COLUMN,
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

describe('isDocumentFileSlot', () => {
  it('распознаёт валидные слоты', () => {
    expect(isDocumentFileSlot('front')).toBe(true);
    expect(isDocumentFileSlot('back')).toBe(true);
    expect(isDocumentFileSlot('additional')).toBe(true);
  });

  it('отвергает прочее', () => {
    expect(isDocumentFileSlot('side')).toBe(false);
    expect(isDocumentFileSlot('../front')).toBe(false);
    expect(isDocumentFileSlot('')).toBe(false);
  });
});

describe('SLOT_TO_COLUMN', () => {
  it('маппит слоты на колонки БД', () => {
    expect(SLOT_TO_COLUMN.front).toBe('frontImage');
    expect(SLOT_TO_COLUMN.back).toBe('backImage');
    expect(SLOT_TO_COLUMN.additional).toBe('additionalFiles');
  });
});

describe('buildRelPath', () => {
  it('строит относительный путь со слешами posix', () => {
    expect(buildRelPath(3, 12, 'front', 'jpg', 'ab12cd34')).toBe(
      'documents/3/12/front-ab12cd34.jpg',
    );
  });

  it('укладывается в varchar(100) при реальных id', () => {
    const p = buildRelPath(999999, 999999, 'additional', 'webp', 'ab12cd34');
    expect(p.length).toBeLessThanOrEqual(100);
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
