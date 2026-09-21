/**
 * Раскладка древа на плоскости. Чистый модуль: вход — граф, выход — координаты
 * и линии; SVG рисует то, что здесь посчитано, и ничего не решает сам.
 *
 * Единица раскладки — «пара» (связанные браком люди, обычно двое) с её детьми.
 * Ширина пары = максимум из ширины её людей и суммарной ширины детских пар;
 * родители центрируются над детьми. Человек, у которого в древе есть и
 * родители, и супруг с другими родителями (жена из другой семьи), кладётся
 * ОДИН раз — рядом с супругом под родителями того из них, кто встретился
 * первым; к его собственным родителям тянется отдельная линия. Она может
 * пересечь соседей — это честнее, чем рисовать человека дважды.
 */

import { generations, type FamilyGraph } from './kinship';

export const NODE_W = 172;
export const NODE_H = 72;
const H_GAP = 20;
const ROW_H = 132;
const UNIT_GAP = 36;

export type LayoutNode = { id: number; x: number; y: number; gen: number };
export type LayoutEdge = {
  kind: 'spouse' | 'parent';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};
export type TreeLayout = { nodes: LayoutNode[]; edges: LayoutEdge[]; width: number; height: number };

type Unit = { members: number[]; children: Unit[] };

function orderIds(graph: FamilyGraph, ids: Iterable<number>): number[] {
  return [...ids].sort((a, b) => {
    const pa = graph.people.get(a)!;
    const pb = graph.people.get(b)!;
    return pa.sortOrder - pb.sortOrder || a - b;
  });
}

/** Люди, связанные браком (обычно двое); мужчина слева — так привычнее читать. */
function spouseComponent(graph: FamilyGraph, start: number): number[] {
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const s of graph.spouses.get(cur) ?? []) {
      if (!seen.has(s)) {
        seen.add(s);
        queue.push(s);
      }
    }
  }
  return orderIds(graph, seen).sort((a, b) => {
    const sa = graph.people.get(a)!.sex;
    const sb = graph.people.get(b)!.sex;
    if (sa === sb) return 0;
    if (sa === 'm') return -1;
    if (sb === 'm') return 1;
    return 0;
  });
}

export function layoutTree(graph: FamilyGraph): TreeLayout {
  const gen = generations(graph);
  const placed = new Set<number>();

  function build(start: number): Unit {
    const members = spouseComponent(graph, start).filter((m) => !placed.has(m));
    for (const m of members) placed.add(m);
    const kidIds = new Set<number>();
    for (const m of members) for (const c of graph.children.get(m) ?? []) if (!placed.has(c)) kidIds.add(c);
    const children: Unit[] = [];
    for (const c of orderIds(graph, kidIds)) {
      if (placed.has(c)) continue;
      children.push(build(c));
    }
    return { members, children };
  }

  // Корни — люди без родителей в древе, чей супруг тоже без родителей (иначе
  // пара ляжет под родителей супруга). Порядок — sortOrder, затем id.
  const roots: Unit[] = [];
  const hasParents = (id: number) => (graph.parents.get(id) ?? []).length > 0;
  const candidates = orderIds(graph, graph.people.keys()).filter(
    (id) => !hasParents(id) && !spouseComponent(graph, id).some(hasParents),
  );
  for (const id of candidates) if (!placed.has(id)) roots.push(build(id));
  // Всё, что осталось (кольца, обрывки), — тоже корни, чтобы никого не потерять.
  for (const id of orderIds(graph, graph.people.keys())) if (!placed.has(id)) roots.push(build(id));

  const widths = new Map<Unit, number>();
  function width(u: Unit): number {
    const own = u.members.length * NODE_W + (u.members.length - 1) * H_GAP;
    const kids = u.children.reduce((sum, c) => sum + width(c), 0) + Math.max(0, u.children.length - 1) * UNIT_GAP;
    const w = Math.max(own, kids);
    widths.set(u, w);
    return w;
  }

  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];
  const pos = new Map<number, { x: number; y: number }>();

  function place(u: Unit, left: number): void {
    const w = widths.get(u) ?? width(u);
    const own = u.members.length * NODE_W + (u.members.length - 1) * H_GAP;
    let x = left + (w - own) / 2;
    const g = Math.max(...u.members.map((m) => gen.get(m) ?? 0));
    for (const m of u.members) {
      const y = g * ROW_H;
      pos.set(m, { x, y });
      nodes.push({ id: m, x, y, gen: g });
      x += NODE_W + H_GAP;
    }
    for (let i = 1; i < u.members.length; i++) {
      const a = pos.get(u.members[i - 1]!)!;
      const b = pos.get(u.members[i]!)!;
      edges.push({ kind: 'spouse', x1: a.x + NODE_W, y1: a.y + NODE_H / 2, x2: b.x, y2: b.y + NODE_H / 2 });
    }
    let cx = left + (w - (widths.get(u)! === own ? own : w)) / 2;
    const kidsW = u.children.reduce((s, c) => s + widths.get(c)!, 0) + Math.max(0, u.children.length - 1) * UNIT_GAP;
    cx = left + (w - kidsW) / 2;
    for (const c of u.children) {
      place(c, cx);
      cx += widths.get(c)! + UNIT_GAP;
    }
  }

  let left = 0;
  for (const r of roots) {
    const w = width(r);
    place(r, left);
    left += w + UNIT_GAP * 2;
  }

  // Линии родитель→ребёнок — по всем связям, в том числе к тем родителям, под
  // которыми человек не лежит (жена из другой семьи).
  for (const [child, parentIds] of graph.parents) {
    const c = pos.get(child);
    if (!c) continue;
    const ps = parentIds.map((p) => pos.get(p)).filter((p): p is { x: number; y: number } => Boolean(p));
    if (ps.length === 0) continue;
    // Если оба родителя рядом (пара) — из середины между ними; иначе от каждого.
    const sorted = [...ps].sort((a, b) => a.x - b.x);
    const adjacent =
      sorted.length === 2 &&
      sorted[0]!.y === sorted[1]!.y &&
      sorted[1]!.x - sorted[0]!.x === NODE_W + H_GAP;
    if (adjacent) {
      edges.push({
        kind: 'parent',
        x1: sorted[0]!.x + NODE_W + H_GAP / 2,
        y1: sorted[0]!.y + NODE_H / 2,
        x2: c.x + NODE_W / 2,
        y2: c.y,
      });
    } else {
      for (const p of ps) {
        edges.push({ kind: 'parent', x1: p.x + NODE_W / 2, y1: p.y + NODE_H, x2: c.x + NODE_W / 2, y2: c.y });
      }
    }
  }

  const width_ = Math.max(NODE_W, ...nodes.map((n) => n.x + NODE_W));
  const height = Math.max(NODE_H, ...nodes.map((n) => n.y + NODE_H));
  return { nodes, edges, width: width_, height };
}
