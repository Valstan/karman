import { describe, it, expect } from 'vitest';
import { documentCreateSchema } from './document';

// Регрессия Zod v4 (см. payment.test.ts): issueDate/expiryDate — голые
// optionalDateString; опущенный ключ давал "expected nonoptional".

describe('documentCreateSchema', () => {
  it('парсит создание без issueDate/expiryDate (ключи опущены → null)', () => {
    const r = documentCreateSchema.safeParse({ title: 'Паспорт' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.issueDate).toBe(null);
      expect(r.data.expiryDate).toBe(null);
    }
  });

  it('пустая строка даты → null, валидная дата проходит', () => {
    const r = documentCreateSchema.safeParse({ title: 'Паспорт', issueDate: '', expiryDate: '2030-01-01' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.issueDate).toBe(null);
      expect(r.data.expiryDate).toBe('2030-01-01');
    }
  });

  it('кривая дата отвергается', () => {
    const r = documentCreateSchema.safeParse({ title: 'Паспорт', issueDate: '01.01.2030' });
    expect(r.success).toBe(false);
  });
});
