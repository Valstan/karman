'use client';

import { Fragment, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Trash2, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { BankFormDialog } from './bank-form-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { deleteBankAction } from '@/lib/actions/banks';
import { rankMatches } from '@/lib/search/tiered-search';
import { HighlightedText } from './highlighted-text';
import type { BankListItem } from '@/lib/services/banks';

export function BanksTable({ banks }: { banks: BankListItem[] }) {
  const router = useRouter();
  const [query, setQuery] = useState('');

  // Многоуровневый поиск (#035) — тот же shared-модуль, что в кредитах/документах.
  const { matches, layoutConverted } = useMemo(
    () => rankMatches(query, banks, (b) => [b.name, b.phone, b.website]),
    [banks, query],
  );

  const firstFuzzyIndex = matches.findIndex((m) => m.isFuzzy);

  const rangesFor = (matchIndex: number, field: number) =>
    matches[matchIndex]?.highlights.find((h) => h.field === field)?.ranges;

  async function remove(id: number) {
    const result = await deleteBankAction(id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Банк удалён');
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative sm:max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск: название, телефон…"
          className="pl-8"
        />
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
              <TableHead>Телефон</TableHead>
              <TableHead>Сайт</TableHead>
              <TableHead className="text-right">Кредитов</TableHead>
              <TableHead className="text-right">Действия</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {matches.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  {query.trim() ? 'Ничего не найдено.' : 'Банков пока нет.'}
                </TableCell>
              </TableRow>
            )}
            {matches.map(({ item: bank, isFuzzy }, index) => (
              <Fragment key={bank.id}>
                {isFuzzy && index === firstFuzzyIndex && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5} className="py-1.5 text-xs text-muted-foreground">
                      Похожие (неточное совпадение):
                    </TableCell>
                  </TableRow>
                )}
                <TableRow>
                  <TableCell className="font-medium">
                    <HighlightedText text={bank.name} ranges={rangesFor(index, 0)} />
                  </TableCell>
                  <TableCell>
                    {bank.phone ? (
                      <HighlightedText text={bank.phone} ranges={rangesFor(index, 1)} />
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    {bank.website ? (
                      <a
                        href={bank.website}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        <HighlightedText text={bank.website} ranges={rangesFor(index, 2)} />
                      </a>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-right">{bank.creditsCount}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <BankFormDialog
                        bank={bank}
                        trigger={
                          <Button size="icon" variant="ghost" title="Редактировать">
                            <Pencil className="h-4 w-4" />
                          </Button>
                        }
                      />
                      <ConfirmDialog
                        title="Удалить банк?"
                        description={
                          bank.creditsCount > 0
                            ? 'К банку привязаны кредиты — удаление будет отклонено.'
                            : 'Действие необратимо.'
                        }
                        onConfirm={() => remove(bank.id)}
                        trigger={
                          <Button size="icon" variant="ghost" title="Удалить">
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        }
                      />
                    </div>
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
