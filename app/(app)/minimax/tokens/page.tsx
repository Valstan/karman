import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { tokenProgress } from '@/lib/services/account-tokens';
import { MinimaxTokenTool } from '@/components/app/minimax-token-tool';

/**
 * «Токены аккаунтов MiniMax» — инструмент добычи токенов (заказ владельца 14.11).
 *
 * Заказ: «напишешь скрипт-программу с веб-интерфейсом на кармане, чтобы я туда зашел
 * и просто щелкал кнопку "Следующий" и ты давал ссылку для авторизации, я проходил
 * авторизацию и скрипт забирал токен и клал его в базу для этого аккаунта и так по кругу
 * пока все аккаунты не пройду и не получу токены… если у аккаунта уже есть токен, то его
 * пропустить, и если токены есть у всех аккаунтов то остановить процесс и сообщить
 * оператору что все токены получены».
 *
 * Механика — OAuth device-flow MiniMax (рецепт Сарафана, линия «Телефона», 14.11):
 * сервис печатает ссылку и код, владелец подтверждает в браузере, сервис обменивает код
 * на пару токенов и кладёт её в базу шифротекстом. Refresh-токен у MiniMax одноразовый —
 * поэтому пара отдаётся проекту ОДИН раз, и после отдачи свой refresh мы не крутим.
 *
 * Раздел ТОЛЬКО владельца: там токены агента. Проверка — здесь и в действиях; отказ —
 * 404, как у раздела секретов.
 */
export const dynamic = 'force-dynamic';

export default async function MinimaxTokensPage() {
  const user = await requireUser();
  if (!user.isSuperuser) notFound();

  const progress = await tokenProgress(user);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Токены аккаунтов MiniMax</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Нажми «Следующий», открой ссылку MiniMax, войди этим аккаунтом и подтверди —
          страница заберёт токен и положит его в базу. Аккаунты с уже готовым токеном
          пропускаются.
        </p>
      </div>
      <MinimaxTokenTool progress={progress} />
    </div>
  );
}
