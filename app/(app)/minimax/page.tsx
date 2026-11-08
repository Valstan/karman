import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import {
  accountRating,
  dailyUsage,
  listAccounts,
  listProjects,
  projectUsage,
  projectUsageByDay,
} from '@/lib/services/accounts';
import { MinimaxPanel } from '@/components/app/minimax-panel';

/**
 * «Минимакс» — раздел мультиаккаунта (задача владельца 2026-11-03): аккаунты
 * MiniMax, которыми переключается, пока программирует.
 *
 * Раздел ТОЛЬКО владельца: там пароли. Проверка — здесь (не только в меню) и в
 * действиях; отказ — 404, как у раздела секретов. Второй фактор нужен не на
 * странице, а на ПОКАЗЕ ПАРОЛЯ (он уходит в буфер обмена) — это стоит в
 * действии `revealAccountPasswordAction`.
 *
 * Экран перестроен 04.11: две половины — слева кнопки и статистика, справа
 * аккаунты (см. `components/app/minimax-panel.tsx`).
 */
export default async function MinimaxPage() {
  const user = await requireUser();
  if (!user.isSuperuser) notFound();

  // Один момент на весь список: иначе «свободен через …» в разных строках
  // считалось бы по разным часам, а список мог бы разъехаться при гидрации.
  const now = new Date();
  const [accounts, projects, usage, usageByDay, daily, rating] = await Promise.all([
    listAccounts(user, now),
    listProjects(user),
    projectUsage(user),
    projectUsageByDay(user),
    dailyUsage(user),
    accountRating(user),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold">Минимакс</h1>
        <p className="text-sm text-muted-foreground">
          Аккаунты MiniMax, которыми переключаешься, пока программирует. Копируешь почту или
          пароль — аккаунт гаснет на 10 часов с момента активации, а активация уходит в
          статистику выбранного проекта.
        </p>
      </div>

      <MinimaxPanel
        accounts={accounts}
        projects={projects}
        usage={usage}
        usageByDay={usageByDay}
        daily={daily}
        rating={rating}
        serverNow={now.toISOString()}
      />
    </div>
  );
}
