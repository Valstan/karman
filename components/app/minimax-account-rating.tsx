'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { AccountRatingRow } from '@/lib/accounts/stats';

/**
 * Рейтинг аккаунтов (заказ владельца 05.11: «десятка самых популярных
 * аккаунтов, которые чаще всего активировались, и сколько на них ушло очков»).
 *
 * Порядок и отсечение считает `rankAccounts` — та же чистая функция, что
 * покрыта юнит-гейтом `lib/accounts/stats.test.ts`.
 */
export function MinimaxAccountRating({ rows }: { rows: AccountRatingRow[] }) {
  return (
    <div className="rounded-md border">
      <div className="p-4 pb-2">
        <h2 className="text-lg font-semibold">Рейтинг аккаунтов</h2>
        <p className="text-xs text-muted-foreground">
          Кто активировался чаще всего и сколько очков на него ушло.
        </p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8">#</TableHead>
            <TableHead>Аккаунт</TableHead>
            <TableHead className="text-right">Активаций</TableHead>
            <TableHead className="text-right">Очков</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground">
                Пока ни одной активации.
              </TableCell>
            </TableRow>
          ) : null}
          {rows.map((row, index) => (
            <TableRow key={row.id}>
              <TableCell className="text-muted-foreground">{index + 1}</TableCell>
              <TableCell>
                <div className="truncate font-medium leading-tight">{row.title || '—'}</div>
                <div className="truncate font-mono text-xs text-muted-foreground">{row.email}</div>
              </TableCell>
              <TableCell className="text-right">{row.activations}</TableCell>
              <TableCell className="text-right">{row.tokens}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
