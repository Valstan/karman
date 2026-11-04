import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { listAccount, listProjects } from '@/lib/services/accounts';
import { MinimaxWindow } from '@/components/app/minimax-window';

/**
 * Плавающее окно «Минимакса» (заказ владельца 04.11): отдельное окно
 * браузера, в котором можно копировать почту и пароль, не переключаясь между
 * вкладками.
 *
 * Раздел доступен ТОЛЬКО владельцу: здесь пароли. Проверка — как на странице
 * раздела (404, а не редирект: окно не должно показывать форму входа вместо
 * аккаунта).
 *
 * Страница намеренно вне группы `(app)`: там шапка, меню и подвал — в окне
 * они не нужны, окно должно быть компактным.
 */
export const dynamic = 'force-dynamic';

export default async function MinimaxWindowPage({
  searchParams,
}: {
  searchParams: Promise<{ accountId?: string; projectId?: string }>;
}) {
  const user = await requireUser();
  if (!user.isSuperuser) notFound();

  const params = await searchParams;
  const accountId = Number(params.accountId);
  if (!Number.isInteger(accountId) || accountId <= 0) notFound();

  const [account, projects] = await Promise.all([
    listAccount(user, accountId),
    listProjects(user),
  ]);
  if (!account) notFound();

  const rawProjectId = params.projectId ? Number(params.projectId) : Number.NaN;
  const initialProjectId =
    Number.isInteger(rawProjectId) && rawProjectId > 0 ? rawProjectId : null;

  return (
    <MinimaxWindow
      account={account}
      projects={projects}
      initialProjectId={initialProjectId}
    />
  );
}
