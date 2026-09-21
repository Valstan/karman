'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FileText, Link2, Pencil, Plus, Printer, Trash2, UserPlus, ZoomIn, ZoomOut } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { FamilyPersonDialog, type PersonFormValues, type PersonLink } from '@/components/app/family-person-dialog';
import { addFamilyRelationAction, deleteFamilyPersonAction, deleteFamilyRelationAction } from '@/lib/actions/family';
import { buildGraph, displayLabel, fullName, generations, kinshipLabel, type TreePerson, type TreeRelation } from '@/lib/family/kinship';
import { layoutTree, NODE_H, NODE_W } from '@/lib/family/layout';
import { cn } from '@/lib/utils';

/**
 * Древо семьи: SVG, по которому можно ходить (клик — выбрать, кнопки — добавить
 * родителя/ребёнка/супруга, править, удалить), и «Текстом» — тот же состав
 * людей подряд, по поколениям, со всем, что о каждом известно. Обе вкладки
 * печатаются как есть: на бумагу уходит `.print-area`, остальное скрывает
 * `globals.css`.
 *
 * Родство считается от «точки отсчёта» — человека с флагом «Это я»; её можно
 * временно переключить, чтобы увидеть древо глазами ребёнка или деда.
 */

const ZOOMS = [0.5, 0.65, 0.8, 1, 1.25, 1.5];

export function FamilyTree({
  people,
  relations,
  documentCounts,
  holders,
}: {
  people: TreePerson[];
  relations: TreeRelation[];
  documentCounts: Record<string, number>;
  holders: string[];
}) {
  const router = useRouter();
  const graph = useMemo(() => buildGraph(people, relations), [people, relations]);
  const layout = useMemo(() => layoutTree(graph), [graph]);
  const gens = useMemo(() => generations(graph), [graph]);

  const selfId = people.find((p) => p.isSelf)?.id ?? people[0]?.id ?? null;
  const [rootOverride, setRootOverride] = useState<number | null>(null);
  const rootId = rootOverride !== null && graph.people.has(rootOverride) ? rootOverride : selfId;

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = selectedId !== null ? (graph.people.get(selectedId) ?? null) : null;

  const [zoomIdx, setZoomIdx] = useState(3);
  const zoom = ZOOMS[zoomIdx]!;

  const [dialog, setDialog] = useState<{ person?: TreePerson; link?: PersonLink; defaults?: Partial<PersonFormValues> } | null>(null);

  const kin = (id: number) => (rootId === null ? '' : kinshipLabel(graph, rootId, id));

  function openAdd(as: PersonLink['as']) {
    if (!selected) return;
    const defaults: Partial<PersonFormValues> = {};
    if (as === 'child') defaults.lastName = selected.sex === 'f' ? '' : selected.lastName;
    if (as === 'parent') {
      defaults.lastName = selected.sex === 'f' && selected.maidenName ? selected.maidenName : selected.lastName;
    }
    setDialog({ link: { anchorId: selected.id, as }, defaults });
  }

  async function removePerson(id: number) {
    const result = await deleteFamilyPersonAction({ id });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Удалено');
    setSelectedId(null);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="no-print flex flex-wrap items-center gap-2">
        <Button onClick={() => setDialog({})}>
          <Plus className="mr-1 h-4 w-4" /> Добавить человека
        </Button>
        {people.length > 1 && (
          <Select value={rootId === null ? '' : String(rootId)} onValueChange={(v) => setRootOverride(Number(v))}>
            <SelectTrigger className="w-64" aria-label="Родство считать от">
              <SelectValue placeholder="Родство считать от…" />
            </SelectTrigger>
            <SelectContent>
              {people.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  от: {displayLabel(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="icon" title="Мельче" disabled={zoomIdx === 0} onClick={() => setZoomIdx((i) => i - 1)}>
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
          <Button
            variant="outline"
            size="icon"
            title="Крупнее"
            disabled={zoomIdx === ZOOMS.length - 1}
            onClick={() => setZoomIdx((i) => i + 1)}
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button variant="outline" onClick={() => window.print()}>
            <Printer className="mr-1 h-4 w-4" /> Печать
          </Button>
        </div>
      </div>

      <Tabs defaultValue="tree">
        <TabsList className="no-print">
          <TabsTrigger value="tree">Древо</TabsTrigger>
          <TabsTrigger value="text">Текстом</TabsTrigger>
        </TabsList>

        <TabsContent value="tree">
          {people.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                Древо пустое. Начните с себя: «Добавить человека», поставьте галочку «Это я» — и
                дальше добавляйте родителей, братьев, детей кнопками на выбранном человеке.
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
              <div className="print-area overflow-auto rounded-xl border bg-card p-4">
                <div style={{ width: layout.width * zoom + 32, height: layout.height * zoom + 32 }} className="print:h-auto! print:w-full!">
                  <svg
                    viewBox={`-16 -16 ${layout.width + 32} ${layout.height + 32}`}
                    width={layout.width * zoom + 32}
                    height={layout.height * zoom + 32}
                    className="print:h-auto! print:w-full!"
                    role="img"
                    aria-label="Древо семьи"
                  >
                    {layout.edges.map((e, i) =>
                      e.kind === 'spouse' ? (
                        <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} className="stroke-foreground/50" strokeWidth={2} strokeDasharray="4 3" />
                      ) : (
                        <path
                          key={i}
                          d={`M ${e.x1} ${e.y1} V ${(e.y1 + e.y2) / 2} H ${e.x2} V ${e.y2}`}
                          fill="none"
                          className="stroke-foreground/40"
                          strokeWidth={1.5}
                        />
                      ),
                    )}
                    {layout.nodes.map((n) => {
                      const p = graph.people.get(n.id)!;
                      const label = kin(n.id);
                      const isSel = selectedId === n.id;
                      const docs = p.holder ? (documentCounts[p.holder] ?? 0) : p.isSelf ? (documentCounts[''] ?? 0) : 0;
                      return (
                        <g
                          key={n.id}
                          transform={`translate(${n.x} ${n.y})`}
                          className="cursor-pointer"
                          onClick={() => setSelectedId(n.id)}
                          onDoubleClick={() => setDialog({ person: p })}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') setSelectedId(n.id);
                          }}
                        >
                          <rect
                            width={NODE_W}
                            height={NODE_H}
                            rx={10}
                            className={cn(
                              'fill-background stroke-2',
                              isSel ? 'stroke-primary' : p.isSelf ? 'stroke-accent' : 'stroke-border',
                              p.died && 'fill-muted',
                            )}
                          />
                          <text x={NODE_W / 2} y={20} textAnchor="middle" className="fill-foreground text-[12px] font-semibold">
                            {p.lastName || (p.nickname && !p.firstName ? p.nickname : '')}
                          </text>
                          <text x={NODE_W / 2} y={36} textAnchor="middle" className="fill-foreground text-[12px]">
                            {[p.firstName, p.middleName].filter(Boolean).join(' ')}
                          </text>
                          <text x={NODE_W / 2} y={52} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                            {[label, p.born || p.died ? [p.born, p.died].filter(Boolean).join('–') : ''].filter(Boolean).join(' · ')}
                          </text>
                          <text x={NODE_W / 2} y={65} textAnchor="middle" className="fill-muted-foreground text-[9px]">
                            {[p.nickname, docs > 0 ? `${docs} док.` : ''].filter(Boolean).join(' · ')}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>

              <Card className="no-print h-fit">
                {selected ? (
                  <>
                    <CardHeader>
                      <CardTitle className="text-base">{displayLabel(selected)}</CardTitle>
                      <CardDescription>
                        {[kin(selected.id), selected.nickname].filter(Boolean).join(' · ') || 'Родство не определено'}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                      <PersonSummary p={selected} />
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => openAdd('parent')}>
                          <UserPlus className="mr-1 h-4 w-4" /> Родителя
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => openAdd('child')}>
                          <UserPlus className="mr-1 h-4 w-4" /> Ребёнка
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => openAdd('spouse')}>
                          <UserPlus className="mr-1 h-4 w-4" /> Супруга
                        </Button>
                        <Button size="sm" onClick={() => setDialog({ person: selected })}>
                          <Pencil className="mr-1 h-4 w-4" /> Изменить
                        </Button>
                        {(selected.holder || selected.isSelf) && (
                          <Link
                            href="/documents"
                            className="inline-flex items-center rounded-md border px-3 text-xs font-medium hover:bg-accent"
                            title="Документы этого человека"
                          >
                            <FileText className="mr-1 h-4 w-4" /> Документы
                          </Link>
                        )}
                        <ConfirmDialog
                          trigger={
                            <Button size="sm" variant="ghost">
                              <Trash2 className="mr-1 h-4 w-4 text-destructive" /> Удалить
                            </Button>
                          }
                          title={`Удалить ${displayLabel(selected)} из древа?`}
                          description="Связи этого человека с остальными тоже исчезнут. Документы не трогаются."
                          onConfirm={() => removePerson(selected.id)}
                        />
                      </div>
                      <RelationsPanel graph={graph} relations={relations} person={selected} people={people} />
                    </CardContent>
                  </>
                ) : (
                  <CardContent className="py-8 text-center text-sm text-muted-foreground">
                    Нажмите на человека в древе — здесь появятся его данные и кнопки: добавить
                    родителя, ребёнка, супруга; изменить; удалить. Двойной клик — сразу править.
                  </CardContent>
                )}
              </Card>
            </div>
          )}
        </TabsContent>

        <TabsContent value="text">
          <div className="print-area rounded-xl border bg-card p-6">
            <TextView graph={graph} gens={gens} rootId={rootId} documentCounts={documentCounts} />
          </div>
        </TabsContent>
      </Tabs>

      <FamilyPersonDialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        person={dialog?.person}
        link={dialog?.link}
        anchorName={dialog?.link ? displayLabel(graph.people.get(dialog.link.anchorId)!) : undefined}
        defaults={dialog?.defaults}
        holders={holders}
        onSaved={(id) => setSelectedId(id)}
      />
    </div>
  );
}

function PersonSummary({ p }: { p: TreePerson }) {
  const rows: [string, string][] = [
    ['Родился', [p.born, p.birthPlace].filter(Boolean).join(', ')],
    ['Умер', [p.died, p.deathPlace].filter(Boolean).join(', ')],
    ['Жил', p.residence],
    ['Занятия', p.occupation],
    ['Национальность', p.nationality],
  ];
  const filled = rows.filter(([, v]) => v !== '');
  if (filled.length === 0) return <p className="text-xs text-muted-foreground">Пока только имя.</p>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {filled.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Связи выбранного человека: список с удалением и форма «связать с существующим». */
function RelationsPanel({
  graph,
  relations,
  person,
  people,
}: {
  graph: ReturnType<typeof buildGraph>;
  relations: TreeRelation[];
  person: TreePerson;
  people: TreePerson[];
}) {
  const router = useRouter();
  const [otherId, setOtherId] = useState<string>('');
  const [as, setAs] = useState<'parent' | 'child' | 'spouse'>('child');

  const mine = relations.filter((r) => r.fromId === person.id || r.toId === person.id);
  const describe = (r: TreeRelation): string => {
    const other = graph.people.get(r.fromId === person.id ? r.toId : r.fromId);
    const name = other ? displayLabel(other) : '?';
    if (r.kind === 'spouse') return `супруг(а): ${name}`;
    return r.fromId === person.id ? `ребёнок: ${name}` : `родитель: ${name}`;
  };

  async function remove(id: number) {
    const result = await deleteFamilyRelationAction({ id });
    if (!result.ok) toast.error(result.error);
    else router.refresh();
  }

  async function add() {
    const other = Number(otherId);
    if (!other) return;
    const rel =
      as === 'parent'
        ? { kind: 'parent' as const, fromId: other, toId: person.id }
        : as === 'child'
          ? { kind: 'parent' as const, fromId: person.id, toId: other }
          : { kind: 'spouse' as const, fromId: person.id, toId: other };
    const result = await addFamilyRelationAction({ ...rel, note: '' });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setOtherId('');
    router.refresh();
  }

  const candidates = people.filter((p) => p.id !== person.id);

  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <div className="text-xs font-medium">Связи</div>
      {mine.length === 0 && <p className="text-xs text-muted-foreground">Связей нет.</p>}
      <ul className="flex flex-col gap-1 text-xs">
        {mine.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2">
            <span>{describe(r)}</span>
            <button type="button" className="text-muted-foreground hover:text-destructive" title="Убрать связь" onClick={() => remove(r.id)}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      {candidates.length > 0 && (
        <div className="flex flex-col gap-2 pt-1">
          <div className="text-xs text-muted-foreground">Связать с уже добавленным:</div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={as} onValueChange={(v) => setAs(v as typeof as)}>
              <SelectTrigger className="h-8 w-32 text-xs" aria-label="Кем приходится">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="parent">родитель</SelectItem>
                <SelectItem value="child">ребёнок</SelectItem>
                <SelectItem value="spouse">супруг(а)</SelectItem>
              </SelectContent>
            </Select>
            <Select value={otherId} onValueChange={setOtherId}>
              <SelectTrigger className="h-8 flex-1 text-xs" aria-label="Кто">
                <SelectValue placeholder="кто…" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {displayLabel(p)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" disabled={otherId === ''} onClick={add}>
              <Link2 className="mr-1 h-3.5 w-3.5" /> Связать
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Печатный текст: по поколениям сверху вниз, о каждом — всё, что известно. */
function TextView({
  graph,
  gens,
  rootId,
  documentCounts,
}: {
  graph: ReturnType<typeof buildGraph>;
  gens: Map<number, number>;
  rootId: number | null;
  documentCounts: Record<string, number>;
}) {
  const ordered = [...graph.people.values()].sort(
    (a, b) => (gens.get(a.id) ?? 0) - (gens.get(b.id) ?? 0) || a.sortOrder - b.sortOrder || a.id - b.id,
  );
  if (ordered.length === 0) return <p className="text-sm text-muted-foreground">Древо пустое.</p>;
  const names = (ids: number[] | undefined) => (ids ?? []).map((id) => graph.people.get(id)).filter(Boolean).map((p) => displayLabel(p!)).join(', ');
  const rootName = rootId !== null ? displayLabel(graph.people.get(rootId)!) : '';
  const maxGen = Math.max(0, ...gens.values());
  return (
    <div className="text-sm leading-relaxed">
      <h2 className="mb-1 text-xl font-semibold">Древо семьи</h2>
      {rootName && <p className="mb-4 text-muted-foreground">Родство указано относительно: {rootName}.</p>}
      {ordered.map((p, i) => {
        const g = gens.get(p.id) ?? 0;
        const header = i === 0 || (gens.get(ordered[i - 1]!.id) ?? 0) !== g;
        const kin = rootId !== null ? kinshipLabel(graph, rootId, p.id) : '';
        const docs = p.holder ? (documentCounts[p.holder] ?? 0) : p.isSelf ? (documentCounts[''] ?? 0) : 0;
        const rows: [string, string][] = [
          ['Девичья фамилия', p.maidenName],
          ['Родился(ась)', [p.born, p.birthPlace].filter(Boolean).join(', ')],
          ['Умер(ла)', [p.died, p.deathPlace].filter(Boolean).join(', ')],
          ['Где жил(а)', p.residence],
          ['Род занятий', p.occupation],
          ['Национальность', p.nationality],
          ['Значение фамилии', p.surnameMeaning],
          ['Родители', names(graph.parents.get(p.id))],
          ['Супруг(а)', names(graph.spouses.get(p.id))],
          ['Дети', names(graph.children.get(p.id))],
          ['Документы в «Кармане»', docs > 0 ? `${docs}` : ''],
          ['Заметки', p.notes],
        ];
        return (
          <div key={p.id} className="mb-4 break-inside-avoid">
            {header && (
              <h3 className="mt-6 mb-2 border-b pb-1 text-base font-semibold">
                {generationTitle(g, maxGen, rootId !== null ? (gens.get(rootId) ?? 0) : null)}
              </h3>
            )}
            <div className="font-semibold">
              {fullName(p) || p.nickname}
              {p.nickname && fullName(p) ? ` («${p.nickname}»)` : ''}
              {kin ? ` — ${kin}` : ''}
            </div>
            <dl className="ml-4 grid grid-cols-[max-content_1fr] gap-x-3">
              {rows
                .filter(([, v]) => v !== '')
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}:</dt>
                    <dd className="whitespace-pre-wrap">{v}</dd>
                  </div>
                ))}
            </dl>
          </div>
        );
      })}
    </div>
  );
}

function generationTitle(g: number, maxGen: number, rootGen: number | null): string {
  if (rootGen === null) return `Поколение ${g + 1} из ${maxGen + 1}`;
  const d = rootGen - g;
  if (d === 0) return 'Моё поколение';
  if (d === 1) return 'Родители';
  if (d === 2) return 'Дедушки и бабушки';
  if (d === 3) return 'Прадеды';
  if (d > 3) return `${'Пра'.repeat(d - 2).toLowerCase().replace(/^п/, 'П')}деды`;
  if (d === -1) return 'Дети';
  if (d === -2) return 'Внуки';
  return `${'Пра'.repeat(-d - 2)}внуки`;
}
