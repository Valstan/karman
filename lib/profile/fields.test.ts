import { describe, expect, it } from 'vitest';
import {
  PROFILE_FIELDS,
  PROFILE_FIELD_KEYS,
  emptyProfile,
  formatProfileValue,
  profileFieldGroups,
  profileFieldLabel,
} from './fields';

/**
 * Список полей карточки — общий источник для формы, круга и выгрузки. Здесь
 * проверяется не «список красивый», а то, что три потребителя не разъедутся:
 * ключи совпадают с формой пустой карточки, дубликатов нет, группы не рвутся.
 */

describe('PROFILE_FIELDS', () => {
  it('покрывает ровно те же ключи, что и пустая карточка', () => {
    // Расхождение здесь означало бы поле, которое форма показывает, а выгрузка
    // молча отдаёт пустым (или наоборот) — без всякой ошибки.
    expect([...PROFILE_FIELD_KEYS].sort()).toEqual(Object.keys(emptyProfile()).sort());
  });

  it('не содержит дубликатов ключей', () => {
    expect(new Set(PROFILE_FIELD_KEYS).size).toBe(PROFILE_FIELD_KEYS.length);
  });

  it('у каждого поля непустая подпись', () => {
    for (const field of PROFILE_FIELDS) {
      expect(field.label.trim()).not.toBe('');
    }
  });

  it('группирует поля подряд, не разрывая группу', () => {
    const groups = profileFieldGroups().map((g) => g.group);
    expect(new Set(groups).size).toBe(groups.length);
  });

  it('сохраняет полный набор полей при группировке', () => {
    const flat = profileFieldGroups().flatMap((g) => g.fields.map((f) => f.key));
    expect(flat).toEqual([...PROFILE_FIELD_KEYS]);
  });

  it('отдаёт подпись по ключу и не падает на неизвестном', () => {
    expect(profileFieldLabel('snils')).toBe('СНИЛС');
    expect(profileFieldLabel('нет-такого')).toBe('нет-такого');
  });
});

describe('formatProfileValue', () => {
  it('переводит ISO-дату в привычный вид', () => {
    expect(formatProfileValue('date', '1980-12-31')).toBe('31.12.1980');
  });

  it('НЕ уезжает на день назад западнее Москвы', () => {
    // Ровно этим и опасен toLocaleDateString: `new Date('1980-12-31')` — это
    // полночь UTC, и в любом отрицательном смещении она становится 30 декабря.
    expect(formatProfileValue('date', '1980-01-01')).toBe('01.01.1980');
    expect(formatProfileValue('date', '2000-03-01')).toBe('01.03.2000');
  });

  it('оставляет как есть то, что не разбирается как дата', () => {
    expect(formatProfileValue('date', 'примерно 1980')).toBe('примерно 1980');
  });

  it('не трогает текст и обрезает пробелы', () => {
    expect(formatProfileValue('text', '  123-456-789 00 ')).toBe('123-456-789 00');
  });

  it('пустое и null дают пустую строку', () => {
    expect(formatProfileValue('text', '')).toBe('');
    expect(formatProfileValue('text', null)).toBe('');
    expect(formatProfileValue('date', null)).toBe('');
  });
});
