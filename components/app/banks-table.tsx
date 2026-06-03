'use client';

import { useRouter } from 'next/navigation';
import { Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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
import type { BankListItem } from '@/lib/services/banks';

export function BanksTable({ banks }: { banks: BankListItem[] }) {
  const router = useRouter();

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
          {banks.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                Банков пока нет.
              </TableCell>
            </TableRow>
          )}
          {banks.map((bank) => (
            <TableRow key={bank.id}>
              <TableCell className="font-medium">{bank.name}</TableCell>
              <TableCell>{bank.phone ?? '—'}</TableCell>
              <TableCell>
                {bank.website ? (
                  <a
                    href={bank.website}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    {bank.website}
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
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
