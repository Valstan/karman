'use client';

import { useMemo, useState } from 'react';
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return credits.filter((credit) => {
      if (status !== 'all' && credit.status !== status) return false;
      if (q) {
        const haystack = [credit.name, credit.bankName].join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [credits, query, status]);

  const isFiltered = query.trim() !== '' || status !== 'all';

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
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  {isFiltered ? 'Ничего не найдено.' : 'Кредитов пока нет.'}
                </TableCell>
              </TableRow>
            )}
            {filtered.map((credit) => (
              <TableRow key={credit.id}>
                <TableCell className="font-medium">
                  <Link href={`/credits/${credit.id}`} className="hover:underline">
                    {credit.name}
                  </Link>
                </TableCell>
                <TableCell>{credit.bankName}</TableCell>
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
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
