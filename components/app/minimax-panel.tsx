'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Copy, ExternalLink, KeyRound, LayoutList, Trash2 } from 'lucide-react';
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
import {
  ACTIVATED_PREVIEW_LIMIT,
  ACTIVATION_WINDOW_MS,
  isSpent,
  splitAccounts,
} from '@/lib/accounts/rotation';
import { MinimaxFormDialog } from './minimax-form-dialog';
import { MinimaxActivateDialog } from './minimax-activate-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { MinimaxToolbar } from './minimax-toolbar';
import { MinimaxAccountRow } from './minimax-account-row';
import { MinimaxAllAccountsDialog } from './minimax-all-accounts-dialog';
import { MinimaxActivationsByDay } from './minimax-activations-by-day';
import { MinimaxDailySums } from './minimax-daily-sums';
import { MinimaxAccountRating } from './minimax-account-rating';
import { MinimaxActivityChart } from './minimax-activity-chart';
import {
  copyAccountSecret,
  publishMinimaxActivated,
  subscribeMinimaxActivated,
  type ActivateKind,
} from './minimax-activation';
import { useNowTick } from './use-now';
import type { AccountListItem, ProjectListItem, ProjectUsageDay } from '@/lib/services/accounts';
import type { AccountRatingRow, DailyUsage } from '@/lib/accounts/stats';
import type { ProjectUsage } from '@/lib/accounts/rotation';

/**
 * «Минимакс» — мультиаккаунт (задача владельца 2026-11-03, экран перестроен 04.11).
 *
 * Правило: КОПИРОВАНИЕ почты или пароля = активация. Аккаунт гаснет на СВОИ
 * 24 ЧАСА с момента активации (04.11) — не до полуночи: каждый аккаунт
 * отсчитывает своё время.
 *
 * Экран — две половины (04.11). Слева: кнопки (добавить проект, добавить
 * аккаунт, импорт) и статистика — «Расход по проектам», «Суммы по дням»,
 * «Активации по дням», рейтинг аккаунтов и график активности. Справа — сами
 * аккаунты: наверху ОДИН следующий (тот, что дольше всех не активировался),
 * ниже активированные — свежий сверху; по умолчанию последние 5, полный список —
 * по кнопке «показать все аккаунты».
 *
 * Проект спрашивается ДО гашения и только ОДИН РАЗ на аккаунт: второе нажатие
 * (другая кнопка) копирует молча, с уже выбранным проектом.
 */
export function MinimaxPanel({
  accounts,
  projects,
  usage,
  usageByDay,
  daily,
  rating,
  serverNow,
}: {
  accounts: AccountListItem[];
  projects: ProjectListItem[];
  usage: ProjectUsage[];
  usageByDay: ProjectUsageDay[];
  /** Суммы по дням: активации, задействованные проекты, токены (заказ 05.11). */
  daily: DailyUsage[];
  /** Рейтинг аккаунтов: кто активировался чаще всего (заказ 05.11). */
  rating: AccountRatingRow[];
  /** Момент, на котором сервер посчитал список (ISO) — для гидрации. */
  serverNow: string;
}) {
  const router = useRouter();

  // Часы раздела: обратный отсчёт окна тикает сам. До первого тика показываем
  // серверное время — иначе серверный HTML и первая отрисовка разойдутся.
  const now = useNowTick();
  const clockMs = now ?? new Date(serverNow).getTime();

  // Верхний слот — один следующий аккаунт; ниже — активированные, свежий сверху.
  const { next, activated, queued } = useMemo(
    () => splitAccounts(accounts, new Date(clockMs)),
    [accounts, clockMs],
  );

  // Активация: сначала диалог с проектом (проект спрашивается ДО гашения),
  // потом копирование, потом гашение.
  const [activateTarget, setActivateTarget] = useState<{
    account: AccountListItem;
    kind: ActivateKind;
  } | null>(null);
  const [allOpen, setAllOpen] = useState(false);

  // Проект, выбранный для аккаунта в ЭТОЙ вкладке. Живёт ровно окно активации:
  // следующая сессия (окно истекло) — снова спрашиваем.
  const pickedRef = useRef<Record<number, { projectId: number | null; at: number }>>({});

  // Всплывающее окно активировало аккаунт — список на вкладке должен устареть.
  useEffect(
    () => subscribeMinimaxActivated(() => router.refresh()),
    [router],
  );

  /**
   * Проект для активации: `undefined` — спросить, число — зачесть на проект,
   * null — без проекта.
   *
   * Порядок: сначала выбор, сделанный в этой вкладке (он живёт окно
   * активации), потом проект уже открытой сессии (значит, он уже выбран),
   * иначе — спросить.
   */
  function resolveProject(account: AccountListItem): number | null | undefined {
    const picked = pickedRef.current[account.id];
    if (picked && Date.now() - picked.at < ACTIVATION_WINDOW_MS) return picked.projectId;
    if (isSpent(account, new Date(clockMs))) return account.projectId;
    return undefined;
  }

  function rememberProject(account: AccountListItem, projectId: number | null | undefined) {
    pickedRef.current[account.id] = {
      projectId: projectId === undefined ? account.projectId : projectId,
      at: Date.now(),
    };
  }

  /** Копирование (и гашение): с проектом — молча, без проекта — через диалог. */
  function handleCopy(account: AccountListItem, kind: ActivateKind) {
    const project = resolveProject(account);
    if (project === undefined) {
      setActivateTarget({ account, kind });
      return;
    }
    void copyAndActivate(account, kind, project);
  }

  async function copyAndActivate(
    account: AccountListItem,
    kind: ActivateKind,
    projectId: number | null | undefined,
  ) {
    const outcome = await copyAccountSecret(account, kind, projectId);
    if (!outcome.ok) {
      toast.error(outcome.error);
      return;
    }
    rememberProject(account, projectId);
    toast.success(
      kind === 'email'
        ? 'Почта скопирована — аккаунт погаснет на 24 часа'
        : 'Пароль скопирован — аккаунт погаснет на 24 часа',
    );
    publishMinimaxActivated(account.id);
    router.refresh();
  }

  /**
   * Плавающее окно поверх вкладок (04.11): копировать почту и пароль, не
   * переключаясь между вкладками.
   *
   * Браузер не умеет «держать окно поверх вкладок» — отдельное окно ОС и есть
   * ближайшее, что можно сделать. Имя окна одно: повторное открытие не
   * плодит окна, а поднимает уже открытое.
   */
  function openWindow(account: AccountListItem) {
    const params = new URLSearchParams({ accountId: String(account.id) });
    const project = resolveProject(account);
    if (project !== undefined && project !== null) params.set('projectId', String(project));
    const opened = window.open(
      `/minimax-window?${params.toString()}`,
      'karman-minimax-window',
      'popup=yes,width=460,height=620,resizable=yes,scrollbars=yes',
    );
    if (!opened) {
      toast.error('Браузер заблокировал всплывающее окно — разрешите окна для этого сайта');
      return;
    }
    opened.focus();
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

  const preview = activated.slice(0, ACTIVATED_PREVIEW_LIMIT);
  const allAccounts = useMemo(
    () => [...(next ? [next] : []), ...queued, ...activated],
    [next, queued, activated],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        {/* ЛЕВАЯ ПОЛОВИНА: кнопки и статистика. */}
        <div className="flex flex-col gap-4">
          <MinimaxToolbar />

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

          {/* Суммы по дням: активации, проекты, токены (заказ владельца 05.11). */}
          <MinimaxDailySums days={daily} serverNow={serverNow} />

          {/* Активации по дням: последние 3 дня по умолчанию, вся история — по кнопке. */}
          <MinimaxActivationsByDay rows={usageByDay} />

          {/* Рейтинг: кто аккаунтов активировал чаще всего (заказ владельца 05.11). */}
          <MinimaxAccountRating rows={rating} />

          {/* Кривая активности за 90 дней (заказ владельца 05.11). */}
          <MinimaxActivityChart days={daily} serverNow={serverNow} />

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
                Проектов пока нет — добавьте первый кнопкой «Добавить проект» слева.
              </p>
            )}
          </div>
        </div>

        {/* ПРАВАЯ ПОЛОВИНА: аккаунты. */}
        <div className="flex flex-col gap-4">
          {/* Верхний слот: ОДИН следующий аккаунт. */}
          <div className="rounded-md border border-emerald-500/50 bg-emerald-500/10 p-4">
            {next ? (
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Следующий аккаунт
                  </div>
                  <button
                    type="button"
                    onClick={() => openWindow(next)}
                    title="Открыть в отдельном окне поверх вкладок"
                    className="mt-1 block max-w-full truncate text-left text-lg font-semibold hover:underline"
                  >
                    {next.title || '—'}
                  </button>
                  <div className="font-mono text-sm text-muted-foreground">{next.email}</div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    title="Скопировать почту (аккаунт погаснет на 24 часа)"
                    onClick={() => handleCopy(next, 'email')}
                  >
                    <Copy className="mr-1 h-4 w-4" /> Почта
                  </Button>
                  <Button
                    variant="outline"
                    title="Скопировать пароль (аккаунт погаснет на 24 часа)"
                    onClick={() => handleCopy(next, 'password')}
                  >
                    <KeyRound className="mr-1 h-4 w-4" /> Пароль
                  </Button>
                  <Button
                    variant="outline"
                    title="Открыть в отдельном окне — копировать, не переключаясь между вкладками"
                    onClick={() => openWindow(next)}
                  >
                    <ExternalLink className="mr-1 h-4 w-4" /> В окне
                  </Button>
                  <MinimaxFormDialog
                    account={next}
                    projects={projects}
                    trigger={
                      <Button variant="ghost">Правка</Button>
                    }
                  />
                  <ConfirmDialog
                    title="Удалить аккаунт?"
                    description={`«${next.title || next.email}» будет удалён вместе с историей активаций.`}
                    onConfirm={() => removeAccount(next)}
                    trigger={
                      <Button variant="ghost" size="icon" aria-label="Удалить аккаунт">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    }
                  />
                </div>
              </div>
            ) : (
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Следующий аккаунт
                </div>
                <p className="text-sm text-muted-foreground">
                  Свободных аккаунтов нет — все погашены. Добавьте новый или дождитесь
                  освобождения.
                </p>
              </div>
            )}
          </div>

          {/* Активированные: свежий сверху, по умолчанию последние 5 (заказ 05.11). */}
          <div className="rounded-md border">
            <div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-2">
              <h2 className="text-lg font-semibold">Активированные</h2>
              <Button variant="outline" size="sm" onClick={() => setAllOpen(true)}>
                <LayoutList className="mr-1 h-4 w-4" /> Показать все аккаунты
              </Button>
            </div>
            <div className="flex flex-col gap-2 p-4 pt-0">
              {activated.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Пока никто не активирован — берите верхний аккаунт.
                </p>
              ) : null}
              {preview.map((account) => (
                <MinimaxAccountRow
                  key={account.id}
                  account={account}
                  spent
                  now={now}
                  projects={projects}
                  onCopy={(kind) => handleCopy(account, kind)}
                  onDelete={() => removeAccount(account)}
                  onOpenWindow={() => openWindow(account)}
                />
              ))}
              {activated.length > preview.length ? (
                <p className="text-xs text-muted-foreground">
                  Показаны последние {preview.length} из {activated.length}. Остальные — по кнопке
                  «показать все аккаунты».
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* Активация: проект спрашивается ДО гашения (04.11) и только один раз. */}
      <MinimaxActivateDialog
        open={activateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setActivateTarget(null);
        }}
        account={activateTarget?.account ?? null}
        kind={activateTarget?.kind ?? 'email'}
        projects={projects}
        onActivated={(accountId, projectId) => {
          const account = accounts.find((row) => row.id === accountId);
          if (account) rememberProject(account, projectId);
        }}
      />

      <MinimaxAllAccountsDialog
        open={allOpen}
        onOpenChange={setAllOpen}
        accounts={allAccounts}
        projects={projects}
        now={now}
        onCopy={(account, kind) => handleCopy(account, kind)}
        onDelete={(account) => removeAccount(account)}
      />
    </div>
  );
}
