import { afterEach, describe, expect, it } from 'vitest';
import { checkHotlineBearer, hotlineConfigured } from '@/lib/hotline/auth';

const ENV_KEY = 'HOTLINE_RELAY_SECRET';
const saved = process.env[ENV_KEY];

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

describe('вход relay', () => {
  it('без секрета — выключено: любая проверка false', async () => {
    delete process.env[ENV_KEY];
    expect(await hotlineConfigured()).toBe(false);
    expect(await checkHotlineBearer('Bearer anything')).toBe(false);
  });

  it('с секретом: свой проходит, чужой и бесформенный — нет', async () => {
    process.env[ENV_KEY] = 'test-relay-secret-123';
    expect(await hotlineConfigured()).toBe(true);
    expect(await checkHotlineBearer('Bearer test-relay-secret-123')).toBe(true);
    expect(await checkHotlineBearer('Bearer wrong')).toBe(false);
    expect(await checkHotlineBearer(null)).toBe(false);
    expect(await checkHotlineBearer('test-relay-secret-123')).toBe(false);
  });
});
