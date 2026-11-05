'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ProjectUsageDay } from '@/lib/services/accounts';

/**
 * «Активации по дням» — сколько аккаунтов активировалось в какой день на какой
 * проект (заказ владельца 03.11).
 *
 * 05.11: по умолчанию видны последние ТРИ дня — вся история за месяцы нечитаема,
 * а кнопка под таблицей открывает её целиком.
 */

/** Сколько дней видно по умолчанию (заказ владельца 05.11: «только за последние три дня»). */
export const ACTIVATIONS_BY_DAY_PREVIEW = 3;

export function MinimaxActivationsByDay({ rows }: { rows: ProjectUsageDay[] }) {
  const [expanded, setExpanded] = useState(false);

  const visible = useMemo(() => {
    if (expanded) return rows;
    // Три последних ДНЯ, а не три строки: в одном дне может быть несколько
    // проектов, и три строки одного дня — это не «три дня».
    const recent = [...new Set(rows.map((row) => row.usedOn))].slice(
      0,
      ACTIVATIONS_BY_DAY_PREVIEW,
    );
    return rows.filter((row) => recent.includes(row.usedOn));
  }, [rows, expanded]);

  return (
    <div className="rounded-md border">
      <div className="p-4 pb-2">
        <h2 className="text-lg font-semibold">Активации по дням</h2>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>День</TableHead>
            <TableHead>Проект</TableHead>
            <TableHead className="text-right">Активаций</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.length === 0 ? (
            <TableRow>
              <TableCell colSpan={3} className="text-center text-muted-foreground">
                Пока ни одной активации.
              </TableCell>
            </TableRow>
          ) : null}
          {visible.map((row) => (
            <TableRow key={`${row.usedOn}-${row.projectId ?? 'none'}`}>
              <TableCell className="font-mono text-xs">{row.usedOn}</TableCell>
              <TableCell>{row.projectName ?? 'Без проекта'}</TableCell>
              <TableCell className="text-right">{row.activations}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="p-4 pt-2">
        <Button variant="outline" size="sm" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Свернуть' : `Показать все дни (${rows.length})`}
        </Button>
      </div>
    </div>
  );
}
