import Link from 'next/link';
import { Download, Plus } from 'lucide-react';
import { requireUser } from '@/lib/auth/current-user';
import { listCredits } from '@/lib/services/credits';
import { listBanks } from '@/lib/services/banks';
import { Button, buttonVariants } from '@/components/ui/button';
import { CreditFormDialog } from '@/components/app/credit-form-dialog';
import { CreditsTable } from '@/components/app/credits-table';

export default async function CreditsPage() {
  const user = await requireUser();
  const [credits, banks] = await Promise.all([listCredits(user), listBanks(user)]);
  const bankOptions = banks.map((b) => ({ id: b.id, name: b.name }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Кредиты</h1>
        <div className="flex items-center gap-2">
          {credits.length > 0 && (
            <a href="/api/export/credits" className={buttonVariants({ variant: 'outline' })}>
              <Download className="mr-1 h-4 w-4" /> Экспорт CSV
            </a>
          )}
          <CreditFormDialog
            banks={bankOptions}
            trigger={
              <Button disabled={bankOptions.length === 0}>
                <Plus className="mr-1 h-4 w-4" /> Новый кредит
              </Button>
            }
          />
        </div>
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

      <CreditsTable credits={credits} />
    </div>
  );
}
