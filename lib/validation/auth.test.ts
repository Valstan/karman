import { describe, expect, it } from 'vitest';
import { accountCreateSchema, accountStateSchema } from './auth';

/**
 * Схема приглашения. Отдельное внимание — ОТСУТСТВУЮЩИМ ключам: по G70 в Zod v4
 * недостающий ключ не становится опциональным сам собой, и форма, которая не
 * послала пустое поле, падала бы с `expected nonoptional, received undefined`.
 * Поэтому здесь парсится не только пустая строка, но и объект без ключа вовсе.
 */

describe('accountCreateSchema', () => {
  it('принимает минимум — один логин, остальные ключи ОТСУТСТВУЮТ (G70)', () => {
    const parsed = accountCreateSchema.safeParse({ username: 'ulyana' });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ username: 'ulyana', email: '', firstName: '', lastName: '' });
  });

  it('принимает пустую почту строкой', () => {
    const parsed = accountCreateSchema.safeParse({ username: 'danil', email: '' });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.email).toBe('');
  });

  it('принимает корректную почту', () => {
    const parsed = accountCreateSchema.safeParse({ username: 'danil', email: 'd@example.ru' });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.email).toBe('d@example.ru');
  });

  it('отвергает мусор в почте ВНЯТНЫМ сообщением, а не invalid_union', () => {
    const parsed = accountCreateSchema.safeParse({ username: 'danil', email: 'не-почта' });
    expect(parsed.success).toBe(false);
    // Именно это сообщение уходит в тост владельцу (issues[0].message).
    expect(parsed.error?.issues[0]?.message).toBe('Некорректная почта');
  });

  it('отвергает кириллический логин', () => {
    const parsed = accountCreateSchema.safeParse({ username: 'ульяна' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('латиница');
  });

  it('отвергает пробел в логине', () => {
    expect(accountCreateSchema.safeParse({ username: 'uly ana' }).success).toBe(false);
  });

  it('отвергает слишком короткий логин', () => {
    expect(accountCreateSchema.safeParse({ username: 'u' }).success).toBe(false);
  });

  it('обрезает пробелы по краям логина', () => {
    const parsed = accountCreateSchema.safeParse({ username: '  ulyana  ' });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.username).toBe('ulyana');
  });

  it('пропускает точку, дефис и подчёркивание', () => {
    expect(accountCreateSchema.safeParse({ username: 'u.l-y_a99' }).success).toBe(true);
  });
});

describe('accountStateSchema', () => {
  it('принимает включение и отключение', () => {
    expect(accountStateSchema.safeParse({ userId: 29, isActive: false }).success).toBe(true);
    expect(accountStateSchema.safeParse({ userId: '29', isActive: true }).success).toBe(true);
  });

  it('отвергает отсутствующий флаг — булев ключ по G70 сам опциональным не станет', () => {
    expect(accountStateSchema.safeParse({ userId: 29 }).success).toBe(false);
  });

  it('отвергает нулевой и отрицательный id', () => {
    expect(accountStateSchema.safeParse({ userId: 0, isActive: true }).success).toBe(false);
    expect(accountStateSchema.safeParse({ userId: -1, isActive: true }).success).toBe(false);
  });
});
