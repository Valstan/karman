import { describe, expect, it } from 'vitest';
import { composeExport, exportFileName, renderText } from './compose';
import type { ExportDocument, ExportPerson } from './compose';
import { emptyProfile } from '@/lib/profile/fields';

const ulyana: ExportPerson = {
  userId: 2,
  name: 'Совиных Ульяна',
  profile: {
    ...emptyProfile(),
    lastName: 'Совиных',
    firstName: 'Ульяна',
    birthDate: '1990-05-17',
    snils: '123-456-789 00',
  },
};

const danil: ExportPerson = {
  userId: 3,
  name: 'Совиных Данил',
  profile: { ...emptyProfile(), lastName: 'Совиных', firstName: 'Данил', inn: '770101' },
};

const passport: ExportDocument = {
  id: 10,
  ownerUserId: 2,
  title: 'Паспорт РФ',
  documentType: 'Паспорт РФ',
  documentNumber: '1234 567890',
  issueDate: '2010-03-01',
  expiryDate: null,
  issuingAuthority: 'ОВД',
  fields: [
    { name: 'Код подразделения', value: '430-001' },
    { name: 'Место рождения', value: '' },
    { name: '', value: 'осиротевшее значение' },
  ],
  files: [
    { id: 1, originalName: 'разворот.jpg', isImage: true },
    { id: 2, originalName: '', isImage: false },
  ],
};

const foreignDoc: ExportDocument = { ...passport, id: 11, ownerUserId: 3, title: 'СНИЛС' };

const ALL_PEOPLE = [ulyana, danil];
const ALL_DOCS = [passport, foreignDoc];

describe('composeExport', () => {
  it('берёт только выбранных людей и только выбранные поля', () => {
    const blocks = composeExport(ALL_PEOPLE, ALL_DOCS, {
      personIds: [2],
      fieldKeys: ['birthDate'],
      documentIds: [],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.name).toBe('Совиных Ульяна');
    expect(blocks[0]!.lines).toEqual([{ label: 'Дата рождения', value: '17.05.1990' }]);
  });

  it('выбрасывает поля с пустым значением, а не печатает «СНИЛС: »', () => {
    const blocks = composeExport(ALL_PEOPLE, ALL_DOCS, {
      personIds: [3],
      fieldKeys: ['snils', 'inn'],
      documentIds: [],
    });
    // У Данила СНИЛС не заполнен — строки быть не должно.
    expect(blocks[0]!.lines).toEqual([{ label: 'ИНН', value: '770101' }]);
  });

  it('держит порядок полей как в списке, а не как в выборе галочек', () => {
    const blocks = composeExport(ALL_PEOPLE, ALL_DOCS, {
      personIds: [2],
      // Порядок в выборе намеренно обратный привычному.
      fieldKeys: ['snils', 'birthDate', 'lastName'],
      documentIds: [],
    });
    expect(blocks[0]!.lines.map((l) => l.label)).toEqual([
      'Фамилия',
      'Дата рождения',
      'СНИЛС',
    ]);
  });

  it('не отдаёт чужой документ вместе с человеком', () => {
    // Документ 11 принадлежит Данилу; выбраны Ульяна и оба документа.
    const blocks = composeExport(ALL_PEOPLE, ALL_DOCS, {
      personIds: [2],
      fieldKeys: [],
      documentIds: [10, 11],
    });
    expect(blocks[0]!.documents.map((d) => d.id)).toEqual([10]);
  });

  it('в документе оставляет ядро и заполненные поля, отбрасывая безымянные', () => {
    const blocks = composeExport(ALL_PEOPLE, ALL_DOCS, {
      personIds: [2],
      fieldKeys: [],
      documentIds: [10],
    });
    const labels = blocks[0]!.documents[0]!.lines.map((l) => l.label);
    expect(labels).toEqual(['Вид', 'Номер', 'Дата выдачи', 'Кем выдан', 'Код подразделения']);
    // «Место рождения» пустое, а у третьего поля нет названия — обоих нет.
    expect(labels).not.toContain('Место рождения');
  });

  it('подставляет имя файлу, который его потерял', () => {
    const blocks = composeExport(ALL_PEOPLE, ALL_DOCS, {
      personIds: [2],
      fieldKeys: [],
      documentIds: [10],
    });
    expect(blocks[0]!.documents[0]!.fileNames).toEqual(['разворот.jpg', 'файл 2']);
  });

  it('человек без выбранных данных в выгрузку не попадает', () => {
    // Выбран Данил, но единственное выбранное поле у него пустое.
    const blocks = composeExport(ALL_PEOPLE, ALL_DOCS, {
      personIds: [3],
      fieldKeys: ['snils'],
      documentIds: [],
    });
    expect(blocks).toEqual([]);
  });

  it('пустой выбор даёт пустую выгрузку, а не всё подряд', () => {
    expect(
      composeExport(ALL_PEOPLE, ALL_DOCS, { personIds: [], fieldKeys: [], documentIds: [] }),
    ).toEqual([]);
  });
});

describe('renderText', () => {
  it('собирает читаемый плоский текст', () => {
    const blocks = composeExport(ALL_PEOPLE, ALL_DOCS, {
      personIds: [2],
      fieldKeys: ['birthDate'],
      documentIds: [10],
    });
    const text = renderText(blocks, true);
    expect(text).toContain('Совиных Ульяна');
    expect(text).toContain('Дата рождения: 17.05.1990');
    expect(text).toContain('  Паспорт РФ');
    expect(text).toContain('  Номер: 1234 567890');
    expect(text).toContain('Файлы: разворот.jpg, файл 2');
  });

  it('без имён файлов, когда они не запрошены', () => {
    const blocks = composeExport(ALL_PEOPLE, ALL_DOCS, {
      personIds: [2],
      fieldKeys: [],
      documentIds: [10],
    });
    expect(renderText(blocks, false)).not.toContain('Файлы:');
  });

  it('не оставляет хвостовых пустых строк — они дают лишнюю строку в мессенджере', () => {
    const blocks = composeExport(ALL_PEOPLE, ALL_DOCS, {
      personIds: [2],
      fieldKeys: ['birthDate'],
      documentIds: [],
    });
    const text = renderText(blocks, true);
    expect(text.endsWith('\n')).toBe(false);
  });

  it('пустая выгрузка даёт пустую строку', () => {
    expect(renderText([], true)).toBe('');
  });
});

describe('exportFileName', () => {
  it('склеивает имя с датой — часов в чистом модуле нет намеренно', () => {
    expect(exportFileName('txt', '2026-09-04')).toBe('karman-2026-09-04.txt');
    expect(exportFileName('zip', '2026-09-04')).toBe('karman-2026-09-04.zip');
  });
});
