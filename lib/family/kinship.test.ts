import { describe, expect, it } from 'vitest';
import { bloodLabel, buildGraph, generations, kinshipLabel, type TreePerson, type TreeRelation } from './kinship';
import { layoutTree, NODE_W } from './layout';

function person(id: number, sex: 'm' | 'f' | '', firstName = `P${id}`): TreePerson {
  return {
    id,
    lastName: '',
    firstName,
    middleName: '',
    maidenName: '',
    nickname: '',
    sex,
    born: '',
    birthPlace: '',
    died: '',
    deathPlace: '',
    residence: '',
    occupation: '',
    nationality: '',
    surnameMeaning: '',
    notes: '',
    holder: '',
    isSelf: id === 1,
    sortOrder: id,
  };
}

let seq = 0;
const parent = (from: number, to: number): TreeRelation => ({ id: ++seq, kind: 'parent', fromId: from, toId: to, note: '' });
const spouse = (a: number, b: number): TreeRelation => ({ id: ++seq, kind: 'spouse', fromId: a, toId: b, note: '' });

/**
 * Семья из переписки 21.09: я (1), брат (2), отец (3) и мать (4), дед по отцу (5)
 * и бабушка (6), прадед (7) и прабабушка (8), прапрадед (9, отец прабабушки),
 * родители матери (10, 11), жена (12) и её родители (13, 14), дети (15, 16),
 * дядя — брат отца (17), его жена (18), их сын (19).
 */
function family() {
  const people = [
    person(1, 'm'), person(2, 'm'), person(3, 'm'), person(4, 'f'), person(5, 'm'), person(6, 'f'),
    person(7, 'm'), person(8, 'f'), person(9, 'm'), person(10, 'm'), person(11, 'f'), person(12, 'f'),
    person(13, 'm'), person(14, 'f'), person(15, 'm'), person(16, 'f'), person(17, 'm'), person(18, 'f'),
    person(19, 'm'),
  ];
  const relations = [
    parent(3, 1), parent(4, 1), parent(3, 2), parent(4, 2), spouse(3, 4),
    parent(5, 3), parent(6, 3), spouse(5, 6),
    parent(7, 5), parent(8, 5), spouse(7, 8), parent(9, 8),
    parent(10, 4), parent(11, 4), spouse(10, 11),
    spouse(1, 12), parent(13, 12), parent(14, 12), spouse(13, 14),
    parent(1, 15), parent(12, 15), parent(1, 16), parent(12, 16),
    parent(5, 17), parent(6, 17), spouse(17, 18), parent(17, 19), parent(18, 19),
  ];
  return buildGraph(people, relations);
}

describe('bloodLabel', () => {
  it('прямая линия вверх и вниз', () => {
    expect(bloodLabel(1, 0, 'm')).toBe('отец');
    expect(bloodLabel(2, 0, 'f')).toBe('бабушка');
    expect(bloodLabel(3, 0, 'm')).toBe('прадедушка');
    expect(bloodLabel(4, 0, 'm')).toBe('прапрадедушка');
    expect(bloodLabel(0, 1, 'f')).toBe('дочь');
    expect(bloodLabel(0, 3, 'm')).toBe('правнук');
  });

  it('без пола — оба слова через косую', () => {
    expect(bloodLabel(1, 1, '')).toBe('брат/сестра');
  });
});

describe('kinshipLabel — кровные', () => {
  const g = family();
  it.each([
    [2, 'брат'],
    [3, 'отец'],
    [4, 'мать'],
    [5, 'дедушка'],
    [6, 'бабушка'],
    [7, 'прадедушка'],
    [8, 'прабабушка'],
    [9, 'прапрадедушка'],
    [10, 'дедушка'],
    [15, 'сын'],
    [16, 'дочь'],
    [17, 'дядя'],
    [19, 'двоюродный брат'],
  ])('id %i → %s', (id, label) => {
    expect(kinshipLabel(g, 1, id)).toBe(label);
  });

  it('от лица другого человека слова меняются', () => {
    expect(kinshipLabel(g, 3, 1)).toBe('сын');
    expect(kinshipLabel(g, 9, 1)).toBe('праправнук');
    expect(kinshipLabel(g, 19, 3)).toBe('дядя');
    expect(kinshipLabel(g, 15, 2)).toBe('дядя');
  });
});

describe('kinshipLabel — по браку', () => {
  const g = family();
  it('жена, её родители, жена дяди', () => {
    expect(kinshipLabel(g, 1, 12)).toBe('жена');
    expect(kinshipLabel(g, 1, 13)).toBe('тесть');
    expect(kinshipLabel(g, 1, 14)).toBe('тёща');
    expect(kinshipLabel(g, 1, 18)).toBe('тётя');
  });

  it('со стороны жены: муж, свёкор, деверь; зять для её родителей', () => {
    expect(kinshipLabel(g, 12, 1)).toBe('муж');
    expect(kinshipLabel(g, 12, 3)).toBe('свёкор');
    expect(kinshipLabel(g, 12, 2)).toBe('деверь');
    expect(kinshipLabel(g, 13, 1)).toBe('зять');
  });

  it('несвязанный человек — пустая строка', () => {
    const g2 = buildGraph([person(1, 'm'), person(2, 'f')], []);
    expect(kinshipLabel(g2, 1, 2)).toBe('');
  });
});

describe('generations', () => {
  it('ребёнок ниже родителей, супруги в одном ряду, тесть в ряду с дедом', () => {
    const g = family();
    const gen = generations(g);
    expect(gen.get(9)).toBe(0);
    expect(gen.get(7)).toBe(1);
    expect(gen.get(5)).toBe(2);
    expect(gen.get(3)).toBe(3);
    expect(gen.get(1)).toBe(4);
    expect(gen.get(12)).toBe(4);
    expect(gen.get(13)).toBe(3);
    expect(gen.get(15)).toBe(5);
  });

  it('кольцо в связях не вешает расчёт', () => {
    const g = buildGraph([person(1, 'm'), person(2, 'm')], [parent(1, 2), parent(2, 1)]);
    expect(generations(g).size).toBe(2);
  });
});

describe('layoutTree', () => {
  it('каждый человек ровно один раз, супруги рядом, дети ниже', () => {
    const g = family();
    const layout = layoutTree(g);
    expect(layout.nodes.map((n) => n.id).sort((a, b) => a - b)).toEqual([...g.people.keys()].sort((a, b) => a - b));
    const at = (id: number) => layout.nodes.find((n) => n.id === id)!;
    expect(at(3).y).toBe(at(4).y);
    expect(Math.abs(at(3).x - at(4).x)).toBeGreaterThanOrEqual(NODE_W);
    expect(at(1).y).toBeGreaterThan(at(3).y);
    expect(at(12).y).toBe(at(1).y);
    // Родители жены в древе, но сама она лежит рядом с мужем — линия к ним есть.
    expect(layout.edges.some((e) => e.kind === 'parent' && e.y2 === at(12).y)).toBe(true);
    expect(layout.width).toBeGreaterThan(0);
  });

  it('пустое древо не падает', () => {
    const layout = layoutTree(buildGraph([], []));
    expect(layout.nodes).toEqual([]);
  });
});
