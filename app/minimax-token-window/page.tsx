import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { tokenWindowData } from '@/lib/services/account-tokens';
import { MinimaxTokenWindow } from '@/components/app/minimax-token-window';

/**
 * Всплывающее окно «пароль от аккаунта» для добычи токенов (заказ владельца
 * 14.11): отдельное окно браузера поверх вкладок — чтобы дотянуться до кнопки с
 * клавиатуры, пока в соседней вкладке идёт подтверждение MiniMax.
 *
 * Раздел доступен ТОЛЬКО владельцу: здесь пароли. Проверка — как на странице
 * «Минимакса» (404, а не редирект: окно не должно показывать форму входа вместо
 * аккаунта).
 *
 * Страница намеренно вне группы `(app)`: там шапка, меню и подвал — в окне они не
 * нужны, окно должно быть компактным.
 *
 * В адресе окна — только `flow=<id>`: код подтверждения живёт пять минут, и в URL
 * он остался бы в журнале доступа. Аккаунт и ссылка берутся из строки потока.
 */
export const dynamic = 'force-dynamic';

export default async function MinimaxTokenWindowPage({
  searchParams,
}: {
  searchParams: Promise<{
    flow?: string;
    copied?: string;
  }>;
}) {
  const user = await requireUser();
  if (!user.isSuperuser) notFound();

  const params = await searchParams;
  const flowId = Number(params.flow);
  if (!Number.isInteger(flowId) || flowId <= 0) notFound();

  const data = await tokenWindowData(user, flowId);
  if (!data) notFound();

  return (
    <MinimaxTokenWindow
      accountId={data.accountId}
      title={data.title}
      email={data.email}
      emailCopied={params.copied === 'email'}
      verificationLink={data.verificationLink}
    />
  );
}
