'use client';

import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { GripVertical } from 'lucide-react';

/**
 * Блок статистики «Минимакса» — три столбца, разделы перетаскиваются мышью
 * (заказ владельца 18.11: «все разделы статистики сделай перетаскиваемыми вручную,
 * чтобы я сам мог их располагать на странице как мне удобно смотреть»).
 *
 * ## Как это работает
 *
 * - разделы лежат в трёх столбцах; за раздел цепляешься за «ручку» (⠿) и тянешь
 *   его в другой столбец или на другое место;
 * - порядок сохраняется в localStorage браузера — в следующий раз страница
 *   откроется в том же виде;
 * - если в localStorage лежит неизвестный раздел (например, его убрали из кода) —
 *   он просто игнорируется, новые разделы встают в конец.
 *
 * Порядок читается через `useSyncExternalStore`: на сервере localStorage нет, и
 * снимок сервера — пустой, поэтому первый рендер всегда одинаковый (гидрация
 * не ломается), а сохранённый порядок применяется сразу после монтирования.
 */

export type StatisticsSection = {
  /** Идентификатор раздела (для порядка в localStorage). */
  id: string;
  /** Заголовок раздела. */
  title: string;
  /** Содержимое раздела. */
  node: ReactNode;
};

const STORAGE_KEY = 'karman.minimax.statistics.order';
const COLUMN_COUNT = 3;

function parseOrder(raw: string): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}

/** Снимок — сырая строка из хранилища: она стабильна (строка), поэтому React
 *  не зацикливается на перерисовке. Разбор — в useMemo. */
function getSnapshot(): string {
  return window.localStorage.getItem(STORAGE_KEY) ?? '';
}

/** На сервере localStorage нет — снимок сервера всегда пустой. */
function getServerSnapshot(): string {
  return '';
}

export function MinimaxStatisticsGrid({ sections }: { sections: StatisticsSection[] }) {
  const ids = useMemo(() => sections.map((section) => section.id), [sections]);
  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const stored = useMemo(() => parseOrder(raw), [raw]);
  const [manual, setManual] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const columns = useMemo(() => {
    const known = new Set(ids);
    const base = manual ?? stored ?? ids;
    const order = base.filter((id) => known.has(id));
    for (const id of ids) if (!order.includes(id)) order.push(id);
    return distribute(order, COLUMN_COUNT);
  }, [ids, manual, stored]);

  function move(sectionId: string, targetColumn: number, targetIndex: number) {
    const next = columns.map((column) => column.filter((id) => id !== sectionId));
    const column = next[targetColumn] ?? [];
    const index = Math.max(0, Math.min(targetIndex, column.length));
    next[targetColumn] = [...column.slice(0, index), sectionId, ...column.slice(index)];
    const flat = next.flat();
    setManual(flat);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(flat));
    } catch {
      // Хранилище недоступно (приватный режим) — просто не сохраняем.
    }
  }

  const byId = useMemo(() => new Map(sections.map((section) => [section.id, section])), [sections]);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {columns.map((column, columnIndex) => (
        <div
          key={columnIndex}
          className="flex min-h-[4rem] flex-col gap-4 rounded-md border border-dashed p-2"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (dragging) move(dragging, columnIndex, column.length);
            setDragging(null);
          }}
        >
          {column.map((id, index) => {
            const section = byId.get(id);
            if (!section) return null;
            return (
              <div
                key={id}
                draggable
                onDragStart={() => setDragging(id)}
                onDragEnd={() => setDragging(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragging) move(dragging, columnIndex, index);
                  setDragging(null);
                }}
                className="rounded-md border bg-background"
              >
                <div className="flex items-center gap-2 border-b px-3 py-1.5">
                  <span
                    className="cursor-grab text-muted-foreground active:cursor-grabbing"
                    title="Перетащи раздел в другое место"
                    aria-label={`Перетащи раздел «${section.title}»`}
                  >
                    <GripVertical className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-medium">{section.title}</span>
                </div>
                <div className="p-3">{section.node}</div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Разложить разделы по столбцам равными частями (по кругу — по одному). */
function distribute(order: string[], columnCount: number): string[][] {
  const columns: string[][] = Array.from({ length: columnCount }, () => []);
  order.forEach((id, index) => {
    columns[index % columnCount]!.push(id);
  });
  return columns;
}
