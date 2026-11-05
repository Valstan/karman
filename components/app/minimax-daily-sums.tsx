'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  fillDailySeries,
  sortDailyUsage,
  type DailyMetric,
  type DailyUsage,
} from '@/lib/accounts/stats';
import { utcToMoscowLocal } from '@/lib/reminders/time';

/**
 * «Суммы по дням» (заказ владельца 05.11): сколько за день активировано
 * аккаунтов, сколько разных проектов было задействовано и сколько токенов
 * ушло.
 *
 * По умолчанию — последние пять КАЛЕНДАРНЫХ дней: дни без активаций в них тоже
 * стоят (ноль), иначе «последние пять дней» на деле окажутся «пятью последними
 * днями с активностью» — а это разные вещи. Кнопка «показать все дни» под
 * таблицей открывает всю историю активаций.
 *
 * Сортировка — по любой из трёх колонок (активации / проекты / токены):
 * владельцу нужно видеть, в какие дни активность была выше.
 */

/** Сколько дней видно по умолчанию (заказ владельца 05.11: «последние пять дней»). */
export const DAILY_SUMS_PREVIEW = 5;

export function MinimaxDailySums({
  days,
  serverNow,
}: {
  /** Свод по дням (только дни с активациями, свежие сверху). */
  days: DailyUsage[];
  /** Момент, на котором сервер посчитал данные (ISO) — конец последнего дня. */
  serverNow: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [metric, setMetric] = useState<DailyMetric>('activations');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');

  const visible = useMemo(() => {
    const rows = expanded
      ? days
      : fillDailySeries(days, DAILY_SUMS_PREVIEW, utcToMoscowLocal(serverNow).slice(0, 10));
    return sortDailyUsage(rows, metric, direction);
  }, [days, expanded, metric, direction, serverNow]);

  function sortBy(next: DailyMetric) {
    if (next === metric) {
      setDirection(direction === 'desc' ? 'asc' : 'desc');
      return;
    }
    setMetric(next);
    setDirection('desc');
  }

  return (
    <div className="rounded-md border">
      <div className="p-4 pb-2">
        <h2 className="text-lg font-semibold">Суммы по дням</h2>
        <p className="text-xs text-muted-foreground">
          Сколько активаций, сколько проектов и сколько токенов в день. Клик по
          заголовку — сортировка.
        </p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>День</TableHead>
            <TableHead className="text-right">
              <SortButton
                label="Активаций"
                active={metric === 'activations'}
                direction={direction}
                onClick={() => sortBy('activations')}
              />
            </TableHead>
            <TableHead className="text-right">
              <SortButton
                label="Проектов"
                active={metric === 'projects'}
                direction={direction}
                onClick={() => sortBy('projects')}
              />
            </TableHead>
            <TableHead className="text-right">
              <SortButton
                label="Токенов"
                active={metric === 'tokens'}
                direction={direction}
                onClick={() => sortBy('tokens')}
              />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground">
                Пока ни одной активации.
              </TableCell>
            </TableRow>
          ) : null}
          {days.length === 0 ? null : visible.map((day) => (
            <TableRow key={day.usedOn}>
              <TableCell className="font-mono text-xs">{day.usedOn}</TableCell>
              <TableCell className="text-right">{day.activations}</TableCell>
              <TableCell className="text-right">{day.projects}</TableCell>
              <TableCell className="text-right">{day.tokens}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="p-4 pt-2">
        <Button variant="outline" size="sm" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Свернуть' : `Показать все дни (${days.length})`}
        </Button>
      </div>
    </div>
  );
}

/** Заголовок-колонка: клик сортирует, стрелка показывает направление. */
function SortButton({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: 'asc' | 'desc';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 hover:underline"
      title={`Сортировать по «${label}»`}
    >
      {label}
      {active ? (
        direction === 'desc' ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronUp className="h-3.5 w-3.5" />
        )
      ) : null}
    </button>
  );
}
