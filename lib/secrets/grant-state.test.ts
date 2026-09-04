import { describe, expect, it } from 'vitest';
import { grantDelivers, grantState } from './grant-state';

describe('grantState', () => {
  it('предложение без согласия получателя — pending и значения не даёт', () => {
    const g = { acceptedAt: null, revokedAt: null };
    expect(grantState(g)).toBe('pending');
    expect(grantDelivers(g)).toBe(false);
  });

  it('принятая и не отозванная — active, значение идёт', () => {
    const g = { acceptedAt: '2026-09-04T05:00:00.000Z', revokedAt: null };
    expect(grantState(g)).toBe('active');
    expect(grantDelivers(g)).toBe(true);
  });

  it('отзыв старше принятия: отозванное предложение — revoked, а не pending', () => {
    const g = { acceptedAt: null, revokedAt: '2026-09-04T05:00:00.000Z' };
    expect(grantState(g)).toBe('revoked');
    expect(grantDelivers(g)).toBe(false);
  });

  it('отозванная после принятия — revoked', () => {
    const g = { acceptedAt: '2026-09-04T05:00:00.000Z', revokedAt: '2026-09-04T06:00:00.000Z' };
    expect(grantState(g)).toBe('revoked');
    expect(grantDelivers(g)).toBe(false);
  });
});
