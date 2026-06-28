import { describe, it, expect } from 'vitest';
import { generateToken, hashToken, looksLikeToken } from './token';

describe('token', () => {
  it('generateToken: формат skm_, prefix и хэш согласованы', () => {
    const t = generateToken();
    expect(t.token.startsWith('skm_')).toBe(true);
    expect(t.prefix).toBe(t.token.slice(0, 12));
    expect(t.hash).toBe(hashToken(t.token));
    expect(t.hash).toHaveLength(64); // sha256 hex
  });

  it('два токена различны', () => {
    expect(generateToken().token).not.toBe(generateToken().token);
  });

  it('hashToken детерминирован', () => {
    expect(hashToken('skm_abc')).toBe(hashToken('skm_abc'));
  });

  it('looksLikeToken отсеивает мусор', () => {
    expect(looksLikeToken(generateToken().token)).toBe(true);
    expect(looksLikeToken('Bearer xyz')).toBe(false);
    expect(looksLikeToken('skm_short')).toBe(false);
  });
});
