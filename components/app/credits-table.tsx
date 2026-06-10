'use client';

import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDate, formatMoney, formatPercent } from '@/lib/format';
import { rankMatches } from '@/lib/search/tiered-search';
import { HighlightedText } from './highlighted-text';
import {
  CREDIT_STATUS_LABELS,
  creditStatusLabel,
  creditStatusVariant,
  paymentTypeLabel,
} from '@/lib/constants';
import type { CreditListItem } from '@/lib/services/credits';

const STATUS_OPTIONS = Object.entries(CREDIT_STATUS_LABELS) as [string, string][];

export function CreditsTable({ credits }: { credits: CreditListItem[] }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string>('all');

  // Многоуровневый поиск (#035): substring → subsequence → fuzzy, RU↔EN, подсветка.
  const { matches, layoutConverted } = useMemo(() => {
    const byStatus = credits.filter((c) => status === 'all' || c.status === status);
    return rankMatches(query, byStatus, (c) => [c.name, c.bankName]);
  }, [credits, query, status]);

  const firstFuzzyIndex = matches.findIndex((m) => m.isFuzzy);

  const isFiltered = query.trim() !== '' || status !== 'all';

  const rangesFor = (matchIndex: number, field: number) =>
    matches[matchIndex]?.highlights.find((h) => h.field === field)?.ranges;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск: название, банк…"
            className="pl-8"
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="sm:w-40">
            <SelectValue placeholder="Статус" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все статусы</SelectItem>
            {STATUS_OPTIONS.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {layoutConverted && (
        <p className="text-sm text-muted-foreground">
          В набранной раскладке ничего не нашлось — раскладка исправлена автоматически (RU↔EN).
        </p>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Название</TableHead>
              <TableHead>Банк</TableHead>
              <TableHead className="text-right">Сумма</TableHead>
              <TableHead className="text-right">Ставка</TableHead>
              <TableHead>Тип</TableHead>
              <TableHead>Выдан</TableHead>
              <TableHead>Статус</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {matches.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  {isFiltered ? 'Ничего не найдено.' : 'Кредитов пока нет.'}
                </TableCell>
              </TableRow>
            )}
            {matches.map(({ item: credit, isFuzzy }, index) => (
              <Fragment key={credit.id}>
                {isFuzzy && index === firstFuzzyIndex && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={7} className="py-1.5 text-xs text-muted-foreground">
                      Похожие (неточное совпадение):
                    </TableCell>
                  </TableRow>
                )}
                <TableRow>
                  <TableCell className="font-medium">
                    <Link href={`/credits/${credit.id}`} className="hover:underline">
                      <HighlightedText text={credit.name} ranges={rangesFor(index, 0)} />
                    </Link>
                  </TableCell>
                  <TableCell>
                    <HighlightedText text={credit.bankName} ranges={rangesFor(index, 1)} />
                  </TableCell>
                  <TableCell className="text-right">{formatMoney(credit.amount)}</TableCell>
                  <TableCell className="text-right">{formatPercent(credit.interestRate)}</TableCell>
                  <TableCell>{paymentTypeLabel(credit.paymentType)}</TableCell>
                  <TableCell>{formatDate(credit.startDate)}</TableCell>
                  <TableCell>
                    <Badge variant={creditStatusVariant(credit.status)}>
                      {creditStatusLabel(credit.status)}
                    </Badge>
                  </TableCell>
                </TableRow>
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
