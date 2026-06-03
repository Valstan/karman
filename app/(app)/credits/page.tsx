import Link from 'next/link';
import { Plus } from 'lucide-react';
import { requireUser } from '@/lib/auth/current-user';
import { listCredits } from '@/lib/services/credits';
import { listBanks } from '@/lib/services/banks';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CreditFormDialog } from '@/components/app/credit-form-dialog';
import { formatDate, formatMoney, formatPercent } from '@/lib/format';
import { creditStatusLabel, creditStatusVariant, paymentTypeLabel } from '@/lib/constants';

export default async function CreditsPage() {
  const user = await requireUser();
  const [credits, banks] = await Promise.all([listCredits(user), listBanks(user)]);
  const bankOptions = banks.map((b) => ({ id: b.id, name: b.name }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Кредиты</h1>
        <CreditFormDialog
          banks={bankOptions}
          trigger={
            <Button disabled={bankOptions.length === 0}>
              <Plus className="mr-1 h-4 w-4" /> Новый кредит
            </Button>
          }
        />
      </div>

      {bankOptions.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Сначала добавьте банк на странице{' '}
          <Link href="/banks" className="underline">
            Банки
          </Link>
          .
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
            {credits.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  Кредитов пока нет.
                </TableCell>
              </TableRow>
            )}
            {credits.map((credit) => (
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
