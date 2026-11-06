'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { fillDailySeries, type DailyUsage } from '@/lib/accounts/stats';
import { utcToMoscowLocal } from '@/lib/reminders/time';

/**
 * График активности (заказ владельца 05.11: «натуральный график, с кривой, чтоб
 * в течение месяца-двух-трёх было видно, как нарастала или спадала активность
 * разработки»).
 *
 * Кривая рисуется СВОИМИ руками на SVG — без библиотеки графиков: их ради одной
 * картинки в проект тащить нечего, а лишняя зависимость — это лишние гейты.
 *
 * Дни без активаций дорисовываются нулями (`fillDailySeries`), иначе кривая
 * рвалась бы и не показывала «день без работы».
 */

const VIEW_W = 640;
const VIEW_H = 180;
const PAD_LEFT = 36;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 22;

/** Сколько дней показывает график (заказ владельца: «месяца 2-3»). */
export const CHART_DAYS = 90;

export function MinimaxActivityChart({
  days,
  serverNow,
}: {
  /** Свод по дням (свежие сверху), как приходит из сервиса. */
  days: DailyUsage[];
  /** Момент, на котором сервер посчитал данные (ISO) — конец графика. */
  serverNow: string;
}) {
  const [metric, setMetric] = useState<'activations' | 'tokens'>('activations');

  const series = useMemo(() => {
    // Конец ряда — московская дата серверного момента: иначе серверная и
    // клиентская отрисовки разошлись бы на сутки в полночь.
    const endDate = utcToMoscowLocal(serverNow).slice(0, 10);
    return fillDailySeries(days, CHART_DAYS, endDate);
  }, [days, serverNow]);

  const values = series.map((day) => day[metric]);
  const max = Math.max(1, ...values);

  const points = series.map((day, index) => {
    const x =
      PAD_LEFT +
      (series.length === 1
        ? 0
        : (index * (VIEW_W - PAD_LEFT - PAD_RIGHT)) / (series.length - 1));
    const y = VIEW_H - PAD_BOTTOM - (day[metric] / max) * (VIEW_H - PAD_TOP - PAD_BOTTOM);
    return { x, y, day };
  });

  const line = smoothPath(points);
  const area = points.length
    ? `${line} L ${points[points.length - 1]!.x} ${VIEW_H - PAD_BOTTOM} L ${points[0]!.x} ${
        VIEW_H - PAD_BOTTOM
      } Z`
    : '';

  const first = series[0];
  const last = series[series.length - 1];

  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-0">
        <div>
          <h2 className="text-lg font-semibold">Активность по дням</h2>
          <p className="text-xs text-muted-foreground">
            Кривая за {CHART_DAYS} дней. Дни без активаций — ноль.
          </p>
        </div>
        <div className="flex gap-1">
          <Button
            variant={metric === 'activations' ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setMetric('activations')}
          >
            Активации
          </Button>
          <Button
            variant={metric === 'tokens' ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setMetric('tokens')}
          >
            Очки
          </Button>
        </div>
      </div>
      <div className="p-4">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="h-48 w-full"
          role="img"
          aria-label={`Активность по дням: ${metric === 'activations' ? 'активации' : 'очки'}`}
        >
          {/* Сетка: ноль, половина, максимум. */}
          {[0, 0.5, 1].map((part) => {
            const y = VIEW_H - PAD_BOTTOM - part * (VIEW_H - PAD_TOP - PAD_BOTTOM);
            return (
              <g key={part}>
                <line
                  x1={PAD_LEFT}
                  x2={VIEW_W - PAD_RIGHT}
                  y1={y}
                  y2={y}
                  className="stroke-muted-foreground/30"
                  strokeWidth={1}
                />
                <text
                  x={PAD_LEFT - 6}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-muted-foreground text-[10px]"
                >
                  {Math.round(max * part)}
                </text>
              </g>
            );
          })}

          {area ? <path d={area} className="fill-primary/10" /> : null}
          {line ? <path d={line} fill="none" className="stroke-primary" strokeWidth={2} /> : null}

          {points.map((point) => (
            <circle
              key={point.day.usedOn}
              cx={point.x}
              cy={point.y}
              r={2.5}
              className="fill-primary"
            >
              <title>
                {point.day.usedOn}: активаций {point.day.activations}, очков {point.day.tokens}
              </title>
            </circle>
          ))}

          {first ? (
            <text
              x={PAD_LEFT}
              y={VIEW_H - 6}
              className="fill-muted-foreground text-[10px]"
            >
              {first.usedOn}
            </text>
          ) : null}
          {last ? (
            <text
              x={VIEW_W - PAD_RIGHT}
              y={VIEW_H - 6}
              textAnchor="end"
              className="fill-muted-foreground text-[10px]"
            >
              {last.usedOn}
            </text>
          ) : null}
        </svg>
      </div>
    </div>
  );
}

/**
 * Кривая по точкам (Catmull-Rom → кубические безье): линия между днями
 * получается плавной, без углов. При одной точке — отрезок, при двух — тоже
 * отрезок (кривая из двух точек вырождается в ломаную).
 */
export function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`;
  if (points.length === 2) {
    return `M ${points[0]!.x} ${points[0]!.y} L ${points[1]!.x} ${points[1]!.y}`;
  }
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}
