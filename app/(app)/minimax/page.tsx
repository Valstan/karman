import { Plus } from 'lucide-react';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { listAccounts, listProjects, projectUsage } from '@/lib/services/accounts';
import { Button } from '@/components/ui/button';
import { MinimaxFormDialog } from '@/components/app/minimax-form-dialog';
import { MinimaxPanel } from '@/components/app/minimax-panel';
/**
 * Мультиаккаунт (задача владельца 2026-11-03): список аккаунтов внешних
 * сервисов, которыми владелец переключается, пока программирует.
 *
 * Раздел ТОЛЬКО владельца: там пароли от внешних сервисов. Проверка — здесь
 * (не только в меню) и в действиях; отказ — 404, как у раздела секретов.
 * Второй фактор нужен не на странице, а на ПОКАЗЕ ПАРОЛЯ (он уходит в буфер
 * обмена) — это стоит в действии `revealAccountPasswordAction`.
 */
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string | string[] }>;
}) {
  const user = await requireUser();
  if (!user.isSuperuser) notFound();
  const [params, accounts, projects, usage] = await Promise.all([
    searchParams,
    listAccounts(user),
    listProjects(user),
    projectUsage(user),
  ]);

  // Выбранный проект — в URL (`/minimax?project=12`), как активная вкладка
  // «Карты». Чужой/несуществующий id молча игнорируем: выбор «без проекта».
  const requested = typeof params.project === 'string' ? Number(params.project) : NaN;
  const currentProjectId = projects.some((project) => project.id === requested)
    ? requested
    : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Минимакс</h1>
          <p className="text-sm text-muted-foreground">
            Аккаунты MiniMax, которыми переключаешься, пока программирует. Копирование почты
            или пароля гасит аккаунт до завтра — он уходит вниз, наверх всплывает следующий
            свободный. Токены вносятся в строке аккаунта.
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
        currentProjectId={currentProjectId}
      />
    </div>
  );
}
