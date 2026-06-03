import { Plus } from 'lucide-react';
import { requireUser } from '@/lib/auth/current-user';
import { listBanks } from '@/lib/services/banks';
import { Button } from '@/components/ui/button';
import { BankFormDialog } from '@/components/app/bank-form-dialog';
import { BanksTable } from '@/components/app/banks-table';

export default async function BanksPage() {
  const user = await requireUser();
  const banks = await listBanks(user);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Банки</h1>
        <BankFormDialog
          trigger={
            <Button>
              <Plus className="mr-1 h-4 w-4" /> Новый банк
            </Button>
          }
        />
      </div>
      <BanksTable banks={banks} />
    </div>
  );
}
