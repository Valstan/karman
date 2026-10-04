import { describe, expect, it } from 'vitest';
import { HOTLINE_DENY_PATTERNS, hotlineLint } from '@/lib/hotline/lint';

/**
 * Позитивный контроль (#262): каждый шаблон обязан быть виден на настоящем
 * артефакте — детектор без позитивного примера считается отсутствующим.
 * Чистые образцы — живая тактика переговорной: согласованию зелёный.
 */
describe('hotlineLint', () => {
  it('каждый шаблон срабатывает на своём артефакте', () => {
    const positives: [string, string][] = [
      ['private-key', 'ключ вот:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAA=='],
      ['github-token', 'токен ghp_abcdefghijklmnopqrst для фетча'],
      ['github-token', 'github_pat_abcdefghijklmnopqrstuvwx лежит в env'],
      ['github-token', 'gho_abcdefghijklmnopqrstuv протух'],
      ['openai-key', 'sk-live-abcdefghij12345 не светить'],
      ['aws-key', 'AKIAIOSFODNN7EXAMPLE в us-east-1'],
      ['slack-token', 'xoxb-1234-abcdef отзови'],
      ['google-oauth', 'ya29.a0AfH6SMBx1234567890_-x обновить'],
      ['google-api-key', 'AIzaSyB1234567890abcdefghi в конфиге'],
      ['secret-assignment', 'подставь token=abcdef123456 в запрос'],
      ['secret-assignment', 'мой password: hunter2x смени'],
      ['vault-room-token', 'забирай skm_a1b2c3d4e5f6g7h8'],
      ['vault-claim-token', 'времянка skb_xyz789013ABC сгорела'],
    ];
    for (const [want, sample] of positives) {
      expect(hotlineLint(sample), `шаблон ${want} не сработал`).toBe(want);
    }
    // Самоконтроль: каждый шаблон из кода покрыт хотя бы одним примером выше.
    const covered = new Set(positives.map(([name]) => name));
    const missing = HOTLINE_DENY_PATTERNS.map((p) => p.name).filter((n) => !covered.has(n));
    expect(missing, 'шаблоны без позитивного примера').toEqual([]);
  });

  it('согласование проходит: grant id, relay без присваивания, ack, done', () => {
    const clean = [
      'answer: grant id=21 готов, забирай accept-ом',
      'wakeup setka: P038 закрыт шагом 9.5 в /reliz, P162 закрыт воркером под X-Relay-Secret',
      'ack: принял, отвечу через ~10 мин',
      'done: диалог закрыт, итог письмом Мозгу',
      'question: где единственная копия закрытого ключа?',
    ];
    for (const text of clean) {
      expect(hotlineLint(text), `ложное срабатывание: ${text}`).toBeNull();
    }
  });
});
