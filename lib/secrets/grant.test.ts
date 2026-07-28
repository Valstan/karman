import { describe, expect, it } from 'vitest';
import { resolveGrants, type GrantAlias } from './grant';

const grant = (id: number, aliasKey: string, sourceKey = 'SRC', sourceProjectId = 6): GrantAlias => ({
  id,
  sourceProjectId,
  sourceKey,
  aliasKey,
});

describe('resolveGrants', () => {
  it('применяет grant, если своего ключа с таким именем нет', () => {
    const { applied, shadowed } = resolveGrants(['OWN_KEY'], [grant(1, 'VMALMYZHE_INGEST_KEY')]);
    expect(applied.map((g) => g.aliasKey)).toEqual(['VMALMYZHE_INGEST_KEY']);
    expect(shadowed).toEqual([]);
  });

  it('собственный ключ комнаты выигрывает у grant (без тихой подмены)', () => {
    const { applied, shadowed } = resolveGrants(['SHARED'], [grant(1, 'SHARED')]);
    expect(applied).toEqual([]);
    expect(shadowed.map((g) => g.id)).toEqual([1]);
  });

  it('при дубле имени побеждает более ранний grant, порядок выборки не влияет', () => {
    const dupes = [grant(7, 'K', 'LATE'), grant(2, 'K', 'EARLY')];
    const forward = resolveGrants([], dupes);
    const reversed = resolveGrants([], [...dupes].reverse());
    expect(forward.applied.map((g) => g.sourceKey)).toEqual(['EARLY']);
    expect(reversed.applied.map((g) => g.sourceKey)).toEqual(['EARLY']);
    expect(forward.shadowed.map((g) => g.id)).toEqual([7]);
  });

  it('несколько независимых grant\'ов применяются все', () => {
    const { applied } = resolveGrants(['OWN'], [grant(1, 'A'), grant(2, 'B'), grant(3, 'C')]);
    expect(applied.map((g) => g.aliasKey)).toEqual(['A', 'B', 'C']);
  });

  it('пустой список grant\'ов — пустой результат', () => {
    expect(resolveGrants(['OWN'], [])).toEqual({ applied: [], shadowed: [] });
  });
});
