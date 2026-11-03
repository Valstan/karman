import { Plus } from 'lucide-react';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import {
  listAccounts,
  listProjects,
  projectUsage,
  projectUsageByDay,
} from '@/lib/services/accounts';
import { Button } from '@/components/ui/button';
import { MinimaxFormDialog } from '@/components/app/minimax-form-dialog';
import { MinimaxPanel } from '@/components/app/minimax-panel';

/**
 * «Минимакс» — раздел мультиаккаунта (задача владельца 2026-11-03): аккаунты
 * MiniMax, которыми владелец переключается, пока программирует.
 *
 * Раздел ТОЛЬКО владельца: там пароли. Проверка — здесь (не только в меню) и в
 * действиях; отказ — 404, как у раздела секретов. Второй фактор нужен не на
 * странице, а на ПОКАЗЕ ПАРОЛЯ (он уходит в буфер обмена) — это стоит в
 * действии `revealAccountPasswordAction`.
 */
export default async function MinimaxPage() {
  const user = await requireUser();
  if (!user.isSuperuser) notFound();
  const [accounts, projects, usage, usageByDay] = await Promise.all([
    listAccounts(user),
    listProjects(user),
    projectUsage(user),
    projectUsageByDay(user),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Минимакс</h1>
          <p className="text-sm text-muted-foreground">
            Аккаунты MiniMax, которыми переключаешься, пока программирует. В строке аккаунта
            выбираешь проект и тут же копируешь почту или пароль — активация уходит в
            статистику этого проекта, а аккаунт гаснет до завтра.
          </p>
        </div>
        {user.isSuperuser ? (
          <MinimaxFormDialog
            trigger={
              <Button>
                <Plus className="mr-1 h-4 w-4" /> Добавить аккаунт
              </Button>
            }
          />
        ) : null}
      </div>

      <MinimaxPanel
        accounts={accounts}
        projects={projects}
        usage={usage}
        usageByDay={usageByDay}
      />
    </div>
  );
}
