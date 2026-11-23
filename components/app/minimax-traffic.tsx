'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  trafficLines,
  type IssuableCounts,
  type TrafficIssue,
  type TrafficStats,
} from '@/lib/accounts/traffic';
import { utcToMoscowLocal } from '@/lib/reminders/time';

/**
 * «Текучка» — поток аккаунтов MiniMax (заказ владельца 23.11).
 *
 * Четыре числа (сколько всего, сколько потрачено сегодня, сколько осталось) и
 * список последних выдач: кому отдали, какому проекту и сколько очков на
 * аккаунте активировали.
 *
 * Числа и подписи считает чистая функция `trafficLines`
 * (`lib/accounts/traffic.ts`) — она под юнит-гейтом, потому что подписи блоков
 * статистики уже однажды разъехались с числами (см. шапку `pool-stats.ts`).
 */

/** Момент по Москве: '23.11 14:32'. */
function moscowTime(iso: string): string {
  if (!iso) return '—';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '—';
  const local = utcToMoscowLocal(new Date(ms));
  return `${local.slice(8, 10)}.${local.slice(5, 7)} ${local.slice(11, 16)}`;
}

/** Кому отдали: комната-потребитель или сам владелец. */
function recipient(issue: TrafficIssue): string {
  if (issue.owner) return 'владелец';
  return issue.room ?? '—';
}

/** Проект потребителя — «на что ушли очки». */
function target(issue: TrafficIssue): string {
  if (issue.project) return issue.project;
  if (issue.area) return issue.area;
  return '—';
}

export function MinimaxTraffic({
  stats,
  issuable,
}: {
  stats: TrafficStats;
  issuable: IssuableCounts;
}) {
  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col gap-1 text-sm">
        {trafficLines(stats, issuable).map((line) => (
          <div key={line.label} className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">{line.label}</dt>
            <dd>{line.value}</dd>
          </div>
        ))}
      </dl>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Аккаунт</TableHead>
            <TableHead>Кому</TableHead>
            <TableHead>Проект</TableHead>
            <TableHead className="text-right">Очки</TableHead>
            <TableHead className="text-right">Когда</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {stats.recent.map((issue, index) => (
            <TableRow key={`${issue.at}-${issue.accountId ?? index}-${index}`}>
              <TableCell>
                {issue.accountId === null ? '—' : `#${issue.accountId}`}
                {issue.title ? <span className="text-muted-foreground"> {issue.title}</span> : null}
              </TableCell>
              <TableCell>{recipient(issue)}</TableCell>
              <TableCell>{target(issue)}</TableCell>
              <TableCell className="text-right">
                {issue.points === null ? '—' : issue.points.toLocaleString('ru-RU')}
              </TableCell>
              <TableCell className="text-right whitespace-nowrap">
                {moscowTime(issue.at)}
              </TableCell>
            </TableRow>
          ))}
          {stats.recent.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                Пока ни одной выдачи за сутки.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}
