import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import {
  apiUsageByDay,
  dailyUsage,
  listAccounts,
  listProjects,
  projectUsage,
  projectUsageByDay,
} from '@/lib/services/accounts';
import { tokenProgress } from '@/lib/services/account-tokens';
import { dailyBonusStats } from '@/lib/services/minimax-daily-bonus';
import { consumerTiers } from '@/lib/services/minimax-consumer-tiers';
import { moscowToday } from '@/lib/accounts/rotation';
import { MinimaxPanel } from '@/components/app/minimax-panel';

/**
 * «Минимакс» — раздел мультиаккаунта (задача владельца 2026-11-03): аккаунты
 * MiniMax, которыми переключается, пока программирует.
 *
 * С 15.11 здесь ВСЁ про MiniMax в одном месте (заказ владельца: «давай все
 * объединим в одно целое… будет одна страница мини макса, и там всё: активации,
 * токен, почта, пароль… если токена нет — предлагай его получить»). Отдельной
 * страницы «Токены аккаунтов MiniMax» больше нет — её адрес ведёт сюда.
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
  const [accounts, projects, usage, usageByDay, daily, apiUsage, tokens, tiers] =
    await Promise.all([
      listAccounts(user, now),
      listProjects(user),
      projectUsage(user),
      projectUsageByDay(user),
      dailyUsage(user),
      apiUsageByDay(user),
      tokenProgress(user, now),
      consumerTiers(30),
    ]);

  // Сводка по суточным бонусам (заказ владельца 18.11): утренний обход забирает
  // бонусы по всем аккаунтам, днём аккаунты раздаются, а по этим цифрам видно,
  // сколько очков в банке, сколько отдано и сколько потрачено.
  const bonus = await dailyBonusStats(moscowToday(now));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Минимакс</h1>
        <p className="text-sm text-muted-foreground">
          Аккаунты MiniMax в одном месте: почта, пароль, активации и токен. Аккаунт,
          у которого суточный бонус ещё сожжён (ночной сброс MiniMax не наступил),
          проектам не выдаётся — очки у него сегодня уже списаны.
        </p>
      </div>

      <MinimaxPanel
        accounts={accounts}
        projects={projects}
        usage={usage}
        usageByDay={usageByDay}
        daily={daily}
        apiUsage={apiUsage}
        tiers={tiers}
        tokenProgress={tokens}
        bonusStats={{
          date: bonus.date,
          accounts: bonus.accounts,
          claimed: bonus.claimed,
          already: bonus.already,
          points: bonus.points,
          handed: bonus.handed,
          handedPoints: bonus.handedPoints,
          spentPoints: bonus.spentPoints,
          leftPoints: bonus.leftPoints,
          thousands: bonus.thousands,
        }}
        serverNow={now.toISOString()}
      />
    </div>
  );
}
