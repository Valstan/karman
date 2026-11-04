'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Copy, KeyRound, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { deleteAccountAction, deleteProjectAction } from '@/lib/actions/accounts';
import { MinimaxFormDialog } from './minimax-form-dialog';
import { MinimaxActivateDialog, type ActivateKind } from './minimax-activate-dialog';
import { ConfirmDialog } from './confirm-dialog';
import type { AccountListItem, ProjectListItem, ProjectUsageDay } from '@/lib/services/accounts';
import type { ProjectUsage } from '@/lib/accounts/rotation';

/** «свободен через 23 ч 12 мин» — обратный отсчёт окна активации. */
function formatRemaining(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} мин`;
  return `${hours} ч ${minutes} мин`;
}

/**
 * «Минимакс» — мультиаккаунт (задача владельца 2026-11-03).
 *
 * Правило: КОПИРОВАНИЕ почты или пароля = активация. Аккаунт гаснет на СВОИ
 * 24 ЧАСА с момента активации (04.11) — не до полуночи: каждый аккаунт
 * отсчитывает своё время. В списке израсходованные уходят вниз (красная
 * строка), наверх всплывает следующий свободный (зелёная строка).
 *
 * Проект спрашивается ДО гашения: кнопка «Почта»/«Пароль» открывает диалог,
 * и только после ответа аккаунт гаснет.
 *
 * Порядок списка: сначала доступные (сверху — тот, что использовался давнее
 * всех или ещё ни разу), ниже — израсходованные.
 */
export function MinimaxPanel({
  accounts,
  projects,
  usage,
  usageByDay,
}: {
  accounts: AccountListItem[];
  projects: ProjectListItem[];
  usage: ProjectUsage[];
  usageByDay: ProjectUsageDay[];
}) {
  const router = useRouter();
  // Активация: сначала диалог с проектом (владелец спрашивает ДО гашения),
  // потом копирование, потом гашение.
  const [activateTarget, setActivateTarget] = useState<{
    account: AccountListItem;
    kind: ActivateKind;
  } | null>(null);

  // Обратный отсчёт идёт сам: окно активации посчитано на сервере, а часы
  // тикают здесь (раз в минуту — «свободен через 23 ч 12 мин»).
  // До первого тика показываем серверное значение — иначе разъедутся
  // серверный HTML и первая отрисовка на клиенте.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      clearTimeout(tick);
      clearInterval(timer);
    };
  }, []);

  function openActivate(account: AccountListItem, kind: ActivateKind) {
    setActivateTarget({ account, kind });
  }

  async function removeAccount(account: AccountListItem) {
    const result = await deleteAccountAction(account.id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Аккаунт удалён');
    router.refresh();
  }

  async function removeProject(id: number) {
    const result = await deleteProjectAction(id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Проект удалён');
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Статистика — ПЕРВОЙ блоком: владелец 03.11 не нашёл её под списком
          аккаунтов. «Активация» — точное имя действия (копирование = активация),
          «погашен» — состояние аккаунта на свои 24 часа. */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-md border">
          <div className="p-4 pb-2">
            <h2 className="text-lg font-semibold">Расход по проектам</h2>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Проект</TableHead>
                <TableHead className="text-right">Активаций</TableHead>
                <TableHead className="text-right">Токенов</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    Пока ни одной активации.
                  </TableCell>
                </TableRow>
              ) : null}
              {usage.map((row) => (
                <TableRow key={row.projectId ?? 'none'}>
                  <TableCell>{row.projectName ?? 'Без проекта'}</TableCell>
                  <TableCell className="text-right">{row.activations}</TableCell>
                  <TableCell className="text-right">{row.tokens}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="rounded-md border">
          <div className="p-4 pb-2">
            <h2 className="text-lg font-semibold">Активации по дням</h2>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>День</TableHead>
                <TableHead>Проект</TableHead>
                <TableHead className="text-right">Активаций</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usageByDay.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    Пока ни одной активации.
                  </TableCell>
                </TableRow>
              ) : null}
              {usageByDay.map((row) => (
                <TableRow key={`${row.usedOn}-${row.projectId ?? 'none'}`}>
                  <TableCell>{row.usedOn}</TableCell>
                  <TableCell>{row.projectName ?? 'Без проекта'}</TableCell>
                  <TableCell className="text-right">{row.activations}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Проекты: справочник названий. */}
      <div className="rounded-md border p-4">
        {projects.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {projects.map((project) => (
              <span
                key={project.id}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-sm"
              >
                {project.name}
                <button
                  type="button"
                  aria-label={`Удалить проект ${project.name}`}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => removeProject(project.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Проектов пока нет — добавьте первый кнопкой «Добавить проект» наверху.
          </p>
        )}
      </div>

      {/* Список аккаунтов: компактная строка, всё по центру. */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-center">Аккаунт</TableHead>
              <TableHead className="w-32 text-center">Почта</TableHead>
              <TableHead className="w-32 text-center">Пароль</TableHead>
              <TableHead className="w-24 text-center">Правка</TableHead>
              <TableHead className="w-16 text-center" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  Аккаунтов пока нет — добавьте первый или импортируйте список.
                </TableCell>
              </TableRow>
            ) : null}
            {accounts.map((account) => (
              <TableRow
                key={account.id}
                className={account.spent ? 'bg-destructive/10' : 'bg-emerald-500/10'}
              >
                <TableCell className="text-center">
                  <div className="font-medium leading-tight">{account.title || '—'}</div>
                  <div className="font-mono text-xs text-muted-foreground">{account.email}</div>
                  {account.spent ? (
                    <div className="text-xs text-muted-foreground">
                      свободен через{' '}
                      {formatRemaining(
                        now === null
                          ? account.remainingMs
                          : Math.max(0, new Date(account.availableAt!).getTime() - now),
                      )}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="text-center">
                  <Button
                    variant="outline"
                    size="sm"
                    title="Скопировать почту (аккаунт погаснет на 24 часа)"
                    onClick={() => openActivate(account, 'email')}
                  >
                    <Copy className="mr-1 h-4 w-4" /> Почта
                  </Button>
                </TableCell>
                <TableCell className="text-center">
                  <Button
                    variant="outline"
                    size="sm"
                    title="Скопировать пароль (аккаунт погаснет на 24 часа)"
                    onClick={() => openActivate(account, 'password')}
                  >
                    <KeyRound className="mr-1 h-4 w-4" /> Пароль
                  </Button>
                </TableCell>
                <TableCell className="text-center">
                  <MinimaxFormDialog
                    account={account}
                    trigger={
                      <Button variant="ghost" size="sm">
                        Правка
                      </Button>
                    }
                  />
                </TableCell>
                <TableCell className="text-center">
                  <ConfirmDialog
                    title="Удалить аккаунт?"
                    description={`«${account.title || account.email}» будет удалён вместе с историей активаций.`}
                    onConfirm={() => removeAccount(account)}
                    trigger={
                      <Button variant="ghost" size="icon" aria-label="Удалить аккаунт">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    }
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Активация: проект спрашивается ДО гашения (04.11). */}
      <MinimaxActivateDialog
        open={activateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setActivateTarget(null);
        }}
        account={activateTarget?.account ?? null}
        kind={activateTarget?.kind ?? 'email'}
        projects={projects}
      />
    </div>
  );
}
