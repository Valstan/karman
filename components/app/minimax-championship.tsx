'use client';

import { useMemo } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { buildChampionship, championshipLeaders } from '@/lib/accounts/stats';
import type { ProjectUsageDay } from '@/lib/services/accounts';

/**
 * «Чемпионат по очкам» — турнирная таблица проектов (заказ владельца 19.11).
 *
 * Правило владельца: «проекты типа участвуют в чемпионате по потраченным очкам. Одна
 * игра — это одни сутки. Какой проект больше остальных потратил очков в сутки — тот и
 * выиграл: за 1 место начисляется 3 балла, за второе место в сутках — 2 балла, и за
 * третье место — 1 балл. Таким образом турнирная таблица: кто больше набрал баллов
 * по суткам, тот выше, кто меньше в сумме набрал, тот ниже».
 *
 * Очки за сутки — сумма `tokens` журнала активаций по проекту за московский день (то
 * же число, что в разделе «Расход по проектам»). Считает чистая функция
 * `buildChampionship` — она же и покрыта юнит-гейтом; компонент только показывает.
 */
export function MinimaxChampionship({ rows }: { rows: ProjectUsageDay[] }) {
  // Журнал отдаёт «очки» в поле tokens — для чемпионата это те же самые очки.
  const points = useMemo(
    () =>
      rows.map((row) => ({
        usedOn: row.usedOn,
        projectId: row.projectId,
        projectName: row.projectName,
        points: row.tokens,
      })),
    [rows],
  );
  const table = useMemo(() => buildChampionship(points), [points]);
  const { usedOn, leaders } = useMemo(() => championshipLeaders(points), [points]);

  if (table.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Пока никто очков не потратил — таблица появится после первых выдач.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        За сутки: 1-е место — 3 балла, 2-е — 2, 3-е — 1. Баллы по суткам суммируются.
      </p>
      {leaders.length > 0 ? (
        <p className="text-sm">
          <span className="text-muted-foreground">{usedOn}: </span>
          {leaders.map((leader, index) => (
            <span key={`${leader.projectName}-${index}`}>
              {index > 0 ? ' · ' : ''}
              {leader.projectName} — {leader.score} ({leader.points.toLocaleString('ru-RU')}{' '}
              очк.)
            </span>
          ))}
        </p>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8">№</TableHead>
            <TableHead>Проект</TableHead>
            <TableHead className="text-right">Баллы</TableHead>
            <TableHead className="text-right">Очков</TableHead>
            <TableHead className="text-right">Суток в тройке</TableHead>
            <TableHead className="text-right">Побед</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.map((row, index) => (
            <TableRow key={row.projectId}>
              <TableCell className="text-muted-foreground">{index + 1}</TableCell>
              <TableCell>{row.projectName}</TableCell>
              <TableCell className="text-right font-medium">{row.points}</TableCell>
              <TableCell className="text-right">{row.spent.toLocaleString('ru-RU')}</TableCell>
              <TableCell className="text-right">{row.topDays}</TableCell>
              <TableCell className="text-right">{row.wins}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
