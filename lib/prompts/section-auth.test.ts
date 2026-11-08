import { describe, expect, it } from 'vitest';

import { sectionSecretName, secretsEqual } from './section-auth';

/**
 * Машинный доступ проекта к своему разделу промтов: токен раздела — это
 * «PROMPTS_TOKEN_» + каноническое имя раздела. Сравнение — constant-time,
 * чтобы по времени ответа нельзя было подбирать чужой токен.
 */
describe('секрет раздела промтов', () => {
  it('имя секрета строится из канонического имени раздела', () => {
    expect(sectionSecretName('MatricaRMZ')).toBe('PROMPTS_TOKEN_MATRICARMZ');
    expect(sectionSecretName('SARAFAN')).toBe('PROMPTS_TOKEN_SARAFAN');
    expect(sectionSecretName('SabantuyMalmyzh')).toBe('PROMPTS_TOKEN_SABANTUYMALMYZH');
    expect(sectionSecretName('trener')).toBe('PROMPTS_TOKEN_TRENER');
    expect(sectionSecretName('brain_matrica')).toBe('PROMPTS_TOKEN_BRAIN_MATRICA');
  });

  it('чужие токены не совпадают, разной длины — тоже', () => {
    expect(secretsEqual('same', 'same')).toBe(true);
    expect(secretsEqual('one', 'two')).toBe(false);
    expect(secretsEqual('short', 'longer-value')).toBe(false);
  });
});
