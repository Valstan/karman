/**
 * Родство — ВЫЧИСЛЯЕТСЯ из двух видов связей (родитель→ребёнок, супруги), а не
 * хранится словом: «дядя» — это «брат родителя», и если хранить оба факта, они
 * разойдутся при первой же правке. Модуль чистый (без `server-only`): его
 * гоняют тесты и клиент древа.
 *
 * Слово родства — относительно ТОЧКИ ОТСЧЁТА (`rootId`, обычно человек с
 * `isSelf`). Сначала ищется кровный путь через ближайшего общего предка
 * (u шагов вверх от точки отсчёта, d шагов вниз до человека), потом — путь
 * через одного супруга с любой стороны (тесть, зять, мачеха, жена брата).
 * Дальше двух браков не ходим: слова для этого в русском языке есть (свояк,
 * сват), но в семейном древе они путают больше, чем объясняют.
 */

export type Sex = 'm' | 'f' | '';

export type TreePerson = {
  id: number;
  lastName: string;
  firstName: string;
  middleName: string;
  maidenName: string;
  nickname: string;
  sex: Sex;
  born: string;
  birthPlace: string;
  died: string;
  deathPlace: string;
  residence: string;
  occupation: string;
  nationality: string;
  surnameMeaning: string;
  notes: string;
  holder: string;
  isSelf: boolean;
  sortOrder: number;
};

export type TreeRelation = {
  id: number;
  kind: 'parent' | 'spouse';
  fromId: number;
  toId: number;
  note: string;
};

export type FamilyGraph = {
  people: Map<number, TreePerson>;
  parents: Map<number, number[]>;
  children: Map<number, number[]>;
  spouses: Map<number, number[]>;
};

function push(map: Map<number, number[]>, key: number, value: number): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else {
    map.set(key, [value]);
  }
}

/** Связи, у которых обе стороны есть среди людей, — остальные молча пропускаются. */
export function buildGraph(people: TreePerson[], relations: TreeRelation[]): FamilyGraph {
  const map = new Map(people.map((p) => [p.id, p]));
  const parents = new Map<number, number[]>();
  const children = new Map<number, number[]>();
  const spouses = new Map<number, number[]>();
  for (const r of relations) {
    if (!map.has(r.fromId) || !map.has(r.toId)) continue;
    if (r.kind === 'parent') {
      push(parents, r.toId, r.fromId);
      push(children, r.fromId, r.toId);
    } else {
      push(spouses, r.fromId, r.toId);
      push(spouses, r.toId, r.fromId);
    }
  }
  return { people: map, parents, children, spouses };
}

export function fullName(p: Pick<TreePerson, 'lastName' | 'firstName' | 'middleName'>): string {
  return [p.lastName, p.firstName, p.middleName]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');
}

/** Имя для подписи в древе: ФИО, а если не заполнено — как зовут в семье. */
export function displayLabel(p: TreePerson): string {
  return fullName(p) || p.nickname || `№${p.id}`;
}

/** Расстояния до всех предков (в шагах вверх), включая самого человека (0). */
function ancestorDistances(graph: FamilyGraph, id: number): Map<number, number> {
  const dist = new Map<number, number>([[id, 0]]);
  const queue = [id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = dist.get(cur)!;
    for (const p of graph.parents.get(cur) ?? []) {
      if (!dist.has(p)) {
        dist.set(p, d + 1);
        queue.push(p);
      }
    }
  }
  return dist;
}

function bySex(sex: Sex, male: string, female: string): string {
  if (sex === 'm') return male;
  if (sex === 'f') return female;
  return `${male}/${female}`;
}

function pra(n: number, base: string): string {
  return 'пра'.repeat(n) + base;
}

/** Слово по числу шагов вверх (u) и вниз (d) через ближайшего общего предка. */
export function bloodLabel(u: number, d: number, sex: Sex): string {
  if (u === 0 && d === 0) return 'я';
  if (u === 0) {
    if (d === 1) return bySex(sex, 'сын', 'дочь');
    if (d === 2) return bySex(sex, 'внук', 'внучка');
    return bySex(sex, pra(d - 2, 'внук'), pra(d - 2, 'внучка'));
  }
  if (d === 0) {
    if (u === 1) return bySex(sex, 'отец', 'мать');
    if (u === 2) return bySex(sex, 'дедушка', 'бабушка');
    return bySex(sex, pra(u - 2, 'дедушка'), pra(u - 2, 'бабушка'));
  }
  if (u === 1 && d === 1) return bySex(sex, 'брат', 'сестра');
  if (u === 2 && d === 1) return bySex(sex, 'дядя', 'тётя');
  if (u === 1 && d === 2) return bySex(sex, 'племянник', 'племянница');
  if (u === 1 && d === 3) return bySex(sex, 'внучатый племянник', 'внучатая племянница');
  if (u === 2 && d === 2) return bySex(sex, 'двоюродный брат', 'двоюродная сестра');
  if (u === 3 && d === 3) return bySex(sex, 'троюродный брат', 'троюродная сестра');
  if (u === 3 && d === 1) return bySex(sex, 'двоюродный дедушка', 'двоюродная бабушка');
  if (u === 3 && d === 2) return bySex(sex, 'двоюродный дядя', 'двоюродная тётя');
  if (u === 2 && d === 3) return bySex(sex, 'двоюродный племянник', 'двоюродная племянница');
  if (u >= 4 && d === 1) return bySex(sex, pra(u - 3, 'двоюродный дедушка'), pra(u - 3, 'двоюродная бабушка'));
  return `родственник (${u} вверх, ${d} вниз)`;
}

/** Кровный путь: (u, d) через ближайшего общего предка, либо null. */
export function bloodPath(graph: FamilyGraph, rootId: number, targetId: number): { u: number; d: number } | null {
  const up = ancestorDistances(graph, rootId);
  const down = ancestorDistances(graph, targetId);
  let best: { u: number; d: number } | null = null;
  for (const [anc, u] of up) {
    const d = down.get(anc);
    if (d === undefined) continue;
    if (!best || u + d < best.u + best.d || (u + d === best.u + best.d && u < best.u)) {
      best = { u, d };
    }
  }
  return best;
}

const GENITIVE: Record<string, string> = {
  брат: 'брата',
  сестра: 'сестры',
  сын: 'сына',
  дочь: 'дочери',
  отец: 'отца',
  мать: 'матери',
  дядя: 'дяди',
  тётя: 'тёти',
  внук: 'внука',
  внучка: 'внучки',
  племянник: 'племянника',
  племянница: 'племянницы',
  дедушка: 'дедушки',
  бабушка: 'бабушки',
  'двоюродный брат': 'двоюродного брата',
  'двоюродная сестра': 'двоюродной сестры',
};

function genitive(label: string): string {
  return GENITIVE[label] ?? `— ${label}`;
}

/**
 * Слово родства человека `targetId` относительно `rootId`. Пустая строка —
 * связи нет (в том числе через один брак).
 */
export function kinshipLabel(graph: FamilyGraph, rootId: number, targetId: number): string {
  if (rootId === targetId) return 'я';
  const root = graph.people.get(rootId);
  const target = graph.people.get(targetId);
  if (!root || !target) return '';

  const blood = bloodPath(graph, rootId, targetId);
  if (blood) return bloodLabel(blood.u, blood.d, target.sex);

  // Родня моего супруга: тесть/свёкор, шурин/золовка, пасынок.
  for (const s of graph.spouses.get(rootId) ?? []) {
    if (s === targetId) return bySex(target.sex, 'муж', 'жена');
    const p = bloodPath(graph, s, targetId);
    if (!p) continue;
    const wifeSide = root.sex !== 'f'; // родня жены — тесть/тёща/шурин; родня мужа — свёкор/свекровь/деверь
    if (p.u === 1 && p.d === 0) return wifeSide ? bySex(target.sex, 'тесть', 'тёща') : bySex(target.sex, 'свёкор', 'свекровь');
    if (p.u === 0 && p.d === 1) return bySex(target.sex, 'пасынок', 'падчерица');
    if (p.u === 1 && p.d === 1) return wifeSide ? bySex(target.sex, 'шурин', 'свояченица') : bySex(target.sex, 'деверь', 'золовка');
    const spouseWord = bySex(root.sex === 'm' ? 'f' : root.sex === 'f' ? 'm' : '', 'мужа', 'жены');
    return `${bloodLabel(p.u, p.d, target.sex)} ${spouseWord}`;
  }

  // Супруг моей родни: зять/невестка, отчим/мачеха, жена брата.
  for (const s of graph.spouses.get(targetId) ?? []) {
    const p = bloodPath(graph, rootId, s);
    if (!p) continue;
    if (p.u === 1 && p.d === 0) return bySex(target.sex, 'отчим', 'мачеха');
    if (p.u === 0 && p.d >= 1) return bySex(target.sex, 'зять', 'невестка');
    if (p.u === 1 && p.d === 1) return bySex(target.sex, 'зять', 'невестка');
    if (p.u === 2 && p.d === 1) return bySex(target.sex, 'дядя', 'тётя');
    return `${bySex(target.sex, 'муж', 'жена')} ${genitive(bloodLabel(p.u, p.d, graph.people.get(s)?.sex ?? ''))}`;
  }

  return '';
}

/**
 * Поколение каждого человека. Обход в ширину от точки отсчёта («я», иначе —
 * первый по порядку): родитель на ряд выше, ребёнок на ряд ниже, супруг в том
 * же ряду. Так родители жены встают в ряд с моими родителями, хотя от них ко
 * мне нет пути «вниз». Кольцо (опечатка «родитель своего деда») не вешает
 * расчёт: каждый человек получает ряд один раз, при первом посещении.
 * Несвязанные куски древа обходятся отдельно, каждый от своего первого.
 * Итог сдвинут так, что самый верхний ряд — 0.
 */
export function generations(graph: FamilyGraph): Map<number, number> {
  const gen = new Map<number, number>();
  const ordered = [...graph.people.values()].sort(
    (a, b) => Number(b.isSelf) - Number(a.isSelf) || a.sortOrder - b.sortOrder || a.id - b.id,
  );
  for (const start of ordered) {
    if (gen.has(start.id)) continue;
    gen.set(start.id, 0);
    const queue = [start.id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const g = gen.get(cur)!;
      const step = (id: number, delta: number) => {
        if (!gen.has(id)) {
          gen.set(id, g + delta);
          queue.push(id);
        }
      };
      for (const p of graph.parents.get(cur) ?? []) step(p, -1);
      for (const c of graph.children.get(cur) ?? []) step(c, 1);
      for (const s of graph.spouses.get(cur) ?? []) step(s, 0);
    }
  }
  const min = Math.min(0, ...gen.values());
  for (const [id, g] of gen) gen.set(id, g - min);
  return gen;
}
