import { describe, it, expect } from 'vitest';
import {
  secretPushSchema,
  secretTokenCreateSchema,
  secretCardCreateSchema,
  secretCardFieldUpsertSchema,
} from './secret';

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

describe('secretCardCreateSchema', () => {
  it('карточка с env-обозначением', () => {
    const r = secretCardCreateSchema.safeParse({ projectId: 1, title: 'Ключ ВК', envKey: 'SECRET_KEY_VK' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.envKey).toBe('SECRET_KEY_VK');
  });

  it('пустое envKey → личная карточка (undefined)', () => {
    const r = secretCardCreateSchema.safeParse({ projectId: 1, title: 'Почта', envKey: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.envKey).toBeUndefined();
  });

  it('envKey не в стиле env-переменной → ошибка', () => {
    expect(secretCardCreateSchema.safeParse({ projectId: 1, title: 'X', envKey: 'has-dash' }).success).toBe(false);
  });

  it('пустое наименование → ошибка', () => {
    expect(secretCardCreateSchema.safeParse({ projectId: 1, title: '  ' }).success).toBe(false);
  });
});

describe('secretCardFieldUpsertSchema', () => {
  it('kind по умолчанию text', () => {
    const r = secretCardFieldUpsertSchema.safeParse({ cardId: 1, name: 'Описание', value: 'x' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.kind).toBe('text');
  });

  it('длинное значение проходит целиком (100 КБ, без обрезания)', () => {
    const long = 'a'.repeat(100 * 1024);
    const r = secretCardFieldUpsertSchema.safeParse({ cardId: 1, name: 'Сертификат', kind: 'secret', value: long });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.value.length).toBe(long.length);
  });

  it('значение больше 256 КБ → ошибка (анти-abuse кап)', () => {
    const huge = 'a'.repeat(262145);
    expect(secretCardFieldUpsertSchema.safeParse({ cardId: 1, name: 'X', value: huge }).success).toBe(false);
  });

  it('неизвестный kind → ошибка', () => {
    expect(secretCardFieldUpsertSchema.safeParse({ cardId: 1, name: 'X', kind: 'blob', value: 'v' }).success).toBe(false);
  });
});
