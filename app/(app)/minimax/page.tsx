import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import {
  listAccounts,
  listProjects,
  projectUsage,
  projectUsageByDay,
} from '@/lib/services/accounts';
import { MinimaxPanel } from '@/components/app/minimax-panel';
import { MinimaxToolbar } from '@/components/app/minimax-toolbar';

/**
 * «Минимакс» — раздел мультиаккаунта (задача владельца 2026-11-03): аккаунты
 * MiniMax, которыми переключается, пока программирует.
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">Минимакс</h1>
          <p className="text-sm text-muted-foreground">
            Аккаунты MiniMax, которыми переключаешься, пока программирует. Копируешь почту или
            пароль — аккаунт гаснет на 24 часа с момента активации, а активация уходит в
            статистику выбранного проекта.
          </p>
        </div>
        {user.isSuperuser ? (
          <div className="shrink-0">
            <MinimaxToolbar />
          </div>
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
