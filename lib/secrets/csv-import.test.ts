import { describe, it, expect } from 'vitest';
import { parseCsv } from '@/lib/csv-parse';
import { mapCsvToCards } from './csv-import';

describe('mapCsvToCards', () => {
  it('экспорт Chrome (name,url,username,password,note) → карточка с полями', () => {
    const csv =
      'name,url,username,password,note\n' +
      'GitHub,https://github.com,valstan,s3cret,рабочий аккаунт';
    const { cards, skipped } = mapCsvToCards(parseCsv(csv));
    expect(skipped).toBe(0);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.title).toBe('GitHub');
    expect(card.fields).toEqual([
      { name: 'Ссылка', kind: 'url', value: 'https://github.com' },
      { name: 'Логин', kind: 'text', value: 'valstan' },
      { name: 'Пароль', kind: 'secret', value: 's3cret' },
      { name: 'Заметка', kind: 'text', value: 'рабочий аккаунт' },
    ]);
  });

  it('строка без наименования пропускается', () => {
    const csv = 'name,password\n,orphan\nOK,pw';
    const { cards, skipped } = mapCsvToCards(parseCsv(csv));
    expect(skipped).toBe(1);
    expect(cards.map((c) => c.title)).toEqual(['OK']);
  });

  it('пустые значения не создают полей', () => {
    const csv = 'name,url,username,password\nSite,,,pw';
    const { cards } = mapCsvToCards(parseCsv(csv));
    expect(cards[0]!.fields).toEqual([{ name: 'Пароль', kind: 'secret', value: 'pw' }]);
  });

  it('неизвестная колонка не теряется — поле с исходным заголовком', () => {
    const csv = 'name,custom_field\nX,значение';
    const { cards } = mapCsvToCards(parseCsv(csv));
    expect(cards[0]!.fields).toEqual([{ name: 'custom_field', kind: 'text', value: 'значение' }]);
  });

  it('нет колонки-наименования → первая колонка как title', () => {
    const csv = 'a,b\nмой ключ,значение';
    const { cards } = mapCsvToCards(parseCsv(csv));
    expect(cards[0]!.title).toBe('мой ключ');
    expect(cards[0]!.fields).toEqual([{ name: 'b', kind: 'text', value: 'значение' }]);
  });

  it('дубли имён полей разводятся суффиксом', () => {
    const csv = 'name,email,почта\nX,a@x.ru,b@x.ru';
    const { cards } = mapCsvToCards(parseCsv(csv));
    // Оба заголовка мапятся в «Логин» → второй становится «Логин 2».
    expect(cards[0]!.fields.map((f) => f.name)).toEqual(['Логин', 'Логин 2']);
  });

  it('только заголовок (нет данных) → пусто', () => {
    expect(mapCsvToCards(parseCsv('name,password'))).toEqual({ cards: [], skipped: 0 });
  });
});
