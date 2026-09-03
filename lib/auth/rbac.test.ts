import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ownership, type SessionUser } from './rbac';
import { creditsCredit, documentsDocument } from '@/lib/db/schema';

/**
 * Регрессия на снятие всевластия суперпользователя (решение владельца 2026-09-03).
 *
 * До этой правки `ownership()` возвращала `undefined` для superuser — фильтр
 * снимался, и владелец видел чужие кредиты и документы подмешанными в свои.
 * Тест проверяет не формулировку, а РЕНДЕР: во что превращается условие в
 * настоящем SQL. Проверять `!== undefined` мало — вернуть можно и «пустое»
 * условие, которое ничего не фильтрует, и такой возврат тип пройдёт.
 */

const dialect = new PgDialect();

function render(user: SessionUser, column: Parameters<typeof ownership>[1]) {
  return dialect.sqlToQuery(ownership(user, column));
}

const owner: SessionUser = {
  id: 1,
  username: 'admin',
  email: 'admin@example.com',
  firstName: '',
  lastName: '',
  isSuperuser: true,
};

const guest: SessionUser = { ...owner, id: 29, username: 'chaka', isSuperuser: false };

describe('ownership', () => {
  it('фильтрует по владельцу обычного пользователя', () => {
    const { sql, params } = render(guest, creditsCredit.userId);
    expect(sql).toContain('"user_id"');
    expect(params).toEqual([29]);
  });

  it('фильтрует суперпользователя ТОЧНО ТАК ЖЕ — всевластия нет', () => {
    const { sql, params } = render(owner, creditsCredit.userId);
    expect(sql).toContain('"user_id"');
    expect(params).toEqual([1]);
  });

  it('условие суперпользователя отличается от обычного только его id', () => {
    const su = render(owner, documentsDocument.userId);
    const plain = render(guest, documentsDocument.userId);
    // Одинаковая форма запроса и разные параметры — это и есть «на общих
    // правах»: суперпользователь не получает более широкой выборки, он просто
    // другой человек.
    expect(su.sql).toBe(plain.sql);
    expect(su.params).not.toEqual(plain.params);
  });

  it('никогда не возвращает undefined — иначе .where() снимет фильтр молча', () => {
    // Именно так дефект и выглядел бы при возврате: drizzle трактует undefined
    // в `.where()` как «условия нет» и отдаёт таблицу целиком.
    expect(ownership(owner, creditsCredit.userId)).toBeDefined();
    expect(ownership(guest, creditsCredit.userId)).toBeDefined();
  });
});
