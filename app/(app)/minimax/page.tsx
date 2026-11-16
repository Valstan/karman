import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import {
  accountRating,
  apiUsageByDay,
  dailyUsage,
  listAccounts,
  listProjects,
  projectUsage,
  projectUsageByDay,
} from '@/lib/services/accounts';
import { tokenProgress } from '@/lib/services/account-tokens';
import { dailyStates, OWNER_TIMEZONE } from '@/lib/services/minimax-daily';
import { isFreshPanelState } from '@/lib/accounts/panel-state';
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
  const [accounts, projects, usage, usageByDay, daily, rating, apiUsage, tokens] =
    await Promise.all([
      listAccounts(user, now),
      listProjects(user),
      projectUsage(user),
      projectUsageByDay(user),
      dailyUsage(user),
      accountRating(user),
      apiUsageByDay(user),
      tokenProgress(user, now),
    ]);

  // Состояние суток по панели MiniMax: что уже прочитано — показываем в строках.
  // Состояние живёт в БД (не в памяти процесса), поэтому страница и выдача видят
  // одно и то же. Протухшее состояние — это «не знаю», а не «очков нет»: в
  // интерфейсе оно помечено отдельно.
  const states = Object.fromEntries(
    [...(await dailyStates(user.id, OWNER_TIMEZONE))].map(([id, state]) => [
      id,
      {
        can_claim: state.can_claim,
        points: state.points,
        status: state.status,
        cell_no: state.cell_no,
        checked_at: state.checked_at,
        stale: !isFreshPanelState(state, now),
      },
    ]),
  );

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
        rating={rating}
        apiUsage={apiUsage}
        tokenProgress={tokens}
        dailyStates={states}
        serverNow={now.toISOString()}
      />
    </div>
  );
}
