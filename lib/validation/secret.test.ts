import { describe, it, expect } from 'vitest';
import { secretPushSchema, secretTokenCreateSchema } from './secret';

describe('secretPushSchema', () => {
  it('валидный набор секретов', () => {
    const r = secretPushSchema.safeParse({ secrets: { DATABASE_URL: 'postgres://x', API_KEY: 'abc' } });
    expect(r.success).toBe(true);
  });

  it('пустой набор → ошибка', () => {
    expect(secretPushSchema.safeParse({ secrets: {} }).success).toBe(false);
  });

  it('некорректное имя ключа → ошибка', () => {
    expect(secretPushSchema.safeParse({ secrets: { '1bad': 'v' } }).success).toBe(false);
    expect(secretPushSchema.safeParse({ secrets: { 'has-dash': 'v' } }).success).toBe(false);
  });

  it('пустое значение → ошибка', () => {
    expect(secretPushSchema.safeParse({ secrets: { OK: '' } }).success).toBe(false);
  });

  it('слишком много ключей (>200) → ошибка', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 201; i++) many[`K${i}`] = 'v';
    expect(secretPushSchema.safeParse({ secrets: many }).success).toBe(false);
  });
});

describe('secretTokenCreateSchema — canWrite', () => {
  it('по умолчанию read-only (canWrite=false)', () => {
    const r = secretTokenCreateSchema.safeParse({ projectId: 1, name: 'ci' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.canWrite).toBe(false);
  });

  it('canWrite=true принимается', () => {
    const r = secretTokenCreateSchema.safeParse({ projectId: 1, name: 'trener', canWrite: true });
    expect(r.success && r.data.canWrite).toBe(true);
  });
});
