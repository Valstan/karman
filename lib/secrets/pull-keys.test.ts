import { describe, expect, it } from 'vitest';
import { parsePullKeys } from './pull-keys';

const p = (qs: string) => parsePullKeys(new URLSearchParams(qs));

describe('parsePullKeys (G331: ожидаемое перечисляется, промах — громкий)', () => {
  it('без key — вся комната (undefined), это единственный «молчаливый» режим', () => {
    expect(p('')).toEqual({ ok: true, keys: undefined });
  });

  it('один ключ — как раньше', () => {
    expect(p('key=DB_PASSWORD')).toEqual({ ok: true, keys: ['DB_PASSWORD'] });
  });

  it('повтор параметра и запятая — оба синтаксиса, дубли схлопываются', () => {
    expect(p('key=A&key=B,C&key=A')).toEqual({ ok: true, keys: ['A', 'B', 'C'] });
  });

  it('пустое имя — ошибка, а не тихий «вся комната»', () => {
    expect(p('key=')).toMatchObject({ ok: false });
    expect(p('key=,')).toMatchObject({ ok: false });
  });

  it('имя не по правилу env-переменной — ошибка с именем', () => {
    expect(p('key=DB-PASSWORD')).toMatchObject({ ok: false, error: expect.stringContaining('DB-PASSWORD') });
  });

  it('кап 200 ключей', () => {
    const many = Array.from({ length: 201 }, (_, i) => `K${i}`).join(',');
    expect(p(`key=${many}`)).toMatchObject({ ok: false });
  });
});
