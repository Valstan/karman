'use client';

import { useRouter } from 'next/navigation';
import { Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { CreditFormDialog } from './credit-form-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { deleteCreditAction, regenerateScheduleAction } from '@/lib/actions/credits';
import type { CreditListItem } from '@/lib/services/credits';

export function CreditActions({
  credit,
  banks,
}: {
  credit: CreditListItem;
  banks: { id: number; name: string }[];
}) {
  const router = useRouter();

  async function regenerate() {
    const result = await regenerateScheduleAction(credit.id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('График перегенерирован');
    router.refresh();
  }

  async function remove() {
    const result = await deleteCreditAction(credit.id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Кредит удалён');
    router.push('/credits');
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <CreditFormDialog
        banks={banks}
        credit={credit}
        trigger={
          <Button variant="outline" size="sm">
            <Pencil className="mr-1 h-4 w-4" /> Изменить
          </Button>
        }
      />
      <ConfirmDialog
        title="Перегенерировать график?"
        description="Будущие запланированные платежи будут заменены новым графиком. Оплаченные и просроченные платежи не затрагиваются."
        confirmText="Перегенерировать"
        onConfirm={regenerate}
        trigger={
          <Button variant="outline" size="sm">
            <RefreshCw className="mr-1 h-4 w-4" /> График
          </Button>
        }
      />
      <ConfirmDialog
        title="Удалить кредит?"
        description="Кредит и все его платежи будут удалены безвозвратно."
        onConfirm={remove}
        trigger={
          <Button variant="outline" size="sm" className="text-destructive">
            <Trash2 className="mr-1 h-4 w-4" /> Удалить
          </Button>
        }
      />
    </div>
  );
}
