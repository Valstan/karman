import { afterEach, describe, expect, it } from 'vitest';
import { checkHotlineBearer, hotlineConfigured } from '@/lib/hotline/auth';

const ENV_KEY = 'HOTLINE_RELAY_SECRET';
const saved = process.env[ENV_KEY];

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

describe('вход relay', () => {
  it('без секрета — выключено: любая проверка false', () => {
    delete process.env[ENV_KEY];
    expect(hotlineConfigured()).toBe(false);
    expect(checkHotlineBearer('Bearer anything')).toBe(false);
  });

  it('с секретом: свой проходит, чужой и бесформенный — нет', () => {
    process.env[ENV_KEY] = 'test-relay-secret-123';
    expect(hotlineConfigured()).toBe(true);
    expect(checkHotlineBearer('Bearer test-relay-secret-123')).toBe(true);
    expect(checkHotlineBearer('Bearer wrong')).toBe(false);
    expect(checkHotlineBearer(null)).toBe(false);
    expect(checkHotlineBearer('test-relay-secret-123')).toBe(false);
  });
});
