'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Copy, ExternalLink, KeyRound, LayoutList, Trash2, Zap } from 'lucide-react';
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
  accountPoolSummary,
  isSpent,
  moscowToday,
  splitAccounts,
} from '@/lib/accounts/rotation';
import { weeklyPoolStats } from '@/lib/accounts/weekly';
import { MinimaxFormDialog } from './minimax-form-dialog';
import { MinimaxActivateDialog } from './minimax-activate-dialog';
import {
  MinimaxAlreadyActivatedDialog,
  type MinimaxBlockedIntent,
} from './minimax-already-activated-dialog';
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
  subscribeMinimaxActivated,
  type ActivateKind,
} from './minimax-activation';
import { useNowTick } from './use-now';
import type { AccountListItem, ProjectListItem, ProjectUsageDay } from '@/lib/services/accounts';
import type { AccountRatingRow, DailyUsage } from '@/lib/accounts/stats';
import { sortProjectsByUsage } from '@/lib/accounts/stats';
import type { ProjectUsage } from '@/lib/accounts/rotation';

/**
 * «Минимакс» — мультиаккаунт (задача владельца 2026-11-03, экран перестроен 04.11,
 * правило и статистика изменены 05.11).
 *
 * Правило: **копирование почты или пароля НЕ гасит аккаунт** (заказ владельца
 * 05.11). Гасит только явная кнопка «Активировать». Аккаунт после активации
 * гаснет на СВОИ 6 ЧАСОВ от момента активации (заказ 07.11) — не до полуночи:
 * каждый аккаунт отсчитывает своё время.
 *
 * Экран — две половины (04.11). Слева: кнопки (добавить проект, добавить
 * аккаунт, импорт) и статистика — «Расход по проектам», «Суммы по дням»,
 * «Активации по дням», рейтинг аккаунтов и график активности. Справа — сами
 * аккаунты: наверху ОДИН следующий (тот, что дольше всех не активировался),
 * ниже активированные — свежий сверху; по умолчанию последние 5, полный список —
 * по кнопке «показать все аккаунты».
 *
 * Защита от повторной активации (05.11): страница иногда не обновляется, и
 * владелец жмёт на уже погашенный аккаунт. Тогда показывается модалка
 * «Аккаунт уже активирован» с выбором: обновить страницу (тогда сверху встанет
 * свежий аккаунт), всё равно скопировать / активировать, или открыть правку.
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
  /** Суммы по дням: активации, задействованные проекты, очки (заказ 05.11). */
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

  // Короткая сводка по запасу (заказ владельца 06.11): сколько аккаунтов
  // свободно сейчас и сколько освободится в ближайшие полчаса. Считается по
  // окнам (у каждого аккаунта своё время), а не по календарю.
  const pool = useMemo(
    () => accountPoolSummary(accounts, new Date(clockMs)),
    [accounts, clockMs],
  );

  // Сводка по недельной квоте (заказ владельца 07.11): сколько активаций
  // возможно сегодня, сколько осталось в неделях и сколько это очков, плюс
  // прогноз по текущему темпу — хватит ли до конца недели.
  const week = useMemo(
    () =>
      weeklyPoolStats(
        accounts.map((account) => ({
          id: account.id,
          spent: account.spent,
          releasesAt: account.availableAt,
          checkedInToday: account.weekCheckedInToday,
          quota: account.week,
        })),
        usageByDay.map((day) => ({ usedOn: day.usedOn, activations: day.activations })),
        moscowToday(new Date(clockMs)),
      ),
    [accounts, usageByDay, clockMs],
  );

  // Активация — только явной кнопкой (заказ владельца 05.11). Копирование
  // почты или пароля аккаунт больше НЕ гасит.
  const [activateTarget, setActivateTarget] = useState<AccountListItem | null>(null);
  const [allOpen, setAllOpen] = useState(false);

  // Правка аккаунта — диалогом панели, а не внутри строки: на уже активированном
  // аккаунте сначала показываем предупреждение и спрашиваем, что делать.
  const [editTarget, setEditTarget] = useState<AccountListItem | null>(null);

  // Аккаунт уже активирован, а владелец нажал копирование / правку / активацию.
  const [blocked, setBlocked] = useState<{
    account: AccountListItem;
    intent: MinimaxBlockedIntent;
  } | null>(null);

  // Всплывающее окно активировало аккаунт — список на вкладке должен устареть.
  useEffect(
    () => subscribeMinimaxActivated(() => router.refresh()),
    [router],
  );

  /** Аккаунт погашен (окно 24 ч не истекло)? */
  function isBlocked(account: AccountListItem): boolean {
    return isSpent(account, new Date(clockMs));
  }

  /**
   * Показываем предупреждение И обновляем список: страница могла устареть, и
   * сверху должен встать свежий, неактивированный аккаунт (заказ 05.11).
   */
  function block(account: AccountListItem, intent: MinimaxBlockedIntent) {
    setBlocked({ account, intent });
    router.refresh();
  }

  /**
   * Копирование: НЕ гасит аккаунт (заказ 05.11). На уже погашенном — спросим,
   * что делать, и перезагрузить ли страницу.
   */
  function handleCopy(account: AccountListItem, kind: ActivateKind) {
    if (isBlocked(account)) {
      block(account, kind === 'email' ? 'copy-email' : 'copy-password');
      return;
    }
    void doCopy(account, kind);
  }

  async function doCopy(account: AccountListItem, kind: ActivateKind) {
    const outcome = await copyAccountSecret(account, kind);
    if (!outcome.ok) {
      toast.error(outcome.error);
      return;
    }
    toast.success(kind === 'email' ? 'Почта скопирована' : 'Пароль скопирован');
  }

  /** Правка аккаунта: на погашенном — сначала предупреждение. */
  function handleEdit(account: AccountListItem) {
    if (isBlocked(account)) {
      block(account, 'edit');
      return;
    }
    setEditTarget(account);
  }

  /** Активация: единственный путь, на котором аккаунт гаснет. */
  function handleActivate(account: AccountListItem) {
    if (isBlocked(account)) {
      block(account, 'activate');
      return;
    }
    setActivateTarget(account);
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

  // Проекты в списках выбора — по частоте: самые ходовые наверху (заказ
  // владельца 05.11). Сам справочник проектов (чипы внизу) остаётся как был.
  const orderedProjects = useMemo(
    () => sortProjectsByUsage(projects, usage),
    [projects, usage],
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
                  <TableHead className="text-right">Очков</TableHead>
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

          {/* Суммы по дням: активации, проекты, очки (заказ владельца 05.11). */}
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
          {/* Сводка по запасу — одна строка над верхним слотом (заказ владельца
              06.11): «Свободных - N, Скоро освободятся - M». Плюс недельная
              квота (заказ 07.11): «За день - X, За неделю - Y (Z очков)» и
              прогноз по текущему темпу — хватит ли до конца недели. */}
          <div className="text-sm font-medium text-muted-foreground">
            Свободных - {pool.free}, Скоро освободятся - {pool.soon}, За день - {week.today},
            За неделю - {week.week} ({week.weekPoints} очков)
            {week.perDay > 0 && week.daysLeft !== null
              ? ` · темп ${week.perDay.toFixed(1)}/день, хватит на ${week.daysLeft.toFixed(1)} дней`
              : ''}
            {week.coversWeek === null
              ? ''
              : week.coversWeek
                ? ' (до конца недели хватит)'
                : ' (до конца недели не хватит)'}
          </div>
          <p className="-mt-4 text-xs text-muted-foreground">
            Неделя у аккаунта своя — 7 дней от его первой активации (так устроено окно
            MiniMax). Очки: 400 за активацию, в 4-й и 7-й — 1000. «За неделю» — сколько
            активаций ещё осталось в недельных циклах всех аккаунтов, «хватит на N дней» —
            при текущем темпе (активаций в день за эту московскую неделю).
          </p>

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
                  {/* Сводка по аккаунту (заказ 05.11): верхний слот тоже может быть
                      не новым — у него есть история активаций. */}
                  {next.activations > 0 ? (
                    <div className="text-xs text-muted-foreground">
                      активаций: {next.activations}
                      {next.totalTokens > 0 ? ` · очков всего: ${next.totalTokens}` : ''}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    title="Скопировать почту (аккаунт не гаснет)"
                    onClick={() => handleCopy(next, 'email')}
                  >
                    <Copy className="mr-1 h-4 w-4" /> Почта
                  </Button>
                  <Button
                    variant="outline"
                    title="Скопировать пароль (аккаунт не гаснет)"
                    onClick={() => handleCopy(next, 'password')}
                  >
                    <KeyRound className="mr-1 h-4 w-4" /> Пароль
                  </Button>
                  {/* Активация — единственное, что гасит аккаунт (заказ 05.11). */}
                  <Button
                    variant="secondary"
                    title="Активировать аккаунт: погаснет на 6 часов"
                    onClick={() => handleActivate(next)}
                  >
                    <Zap className="mr-1 h-4 w-4" /> Активировать
                  </Button>
                  <Button
                    variant="outline"
                    title="Открыть в отдельном окне — копировать, не переключаясь между вкладками"
                    onClick={() => openWindow(next)}
                  >
                    <ExternalLink className="mr-1 h-4 w-4" /> В окне
                  </Button>
                  <Button variant="ghost" onClick={() => handleEdit(next)}>
                    Правка
                  </Button>
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
                  projects={orderedProjects}
                  onCopy={(kind) => handleCopy(account, kind)}
                  onEdit={() => handleEdit(account)}
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

      {/* Активация: проект и очки спрашиваются ДО гашения (04.11). Копирование
          аккаунт не гасит — гасит только эта кнопка (заказ 05.11). */}
      <MinimaxActivateDialog
        open={activateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setActivateTarget(null);
        }}
        account={activateTarget}
        projects={orderedProjects}
      />

      {/* Правка аккаунта — диалог панели: на погашенном аккаунте сначала
          предупреждение и вопрос «обновить или править». */}
      <MinimaxFormDialog
        account={editTarget ?? undefined}
        projects={orderedProjects}
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      />

      {/* «Аккаунт уже активирован»: защита от повторной активации на устаревшей
          странице (заказ 05.11). */}
      <MinimaxAlreadyActivatedDialog
        open={blocked !== null}
        onOpenChange={(open) => {
          if (!open) setBlocked(null);
        }}
        account={blocked?.account ?? null}
        intent={blocked?.intent ?? 'copy-email'}
        now={now}
        onReload={() => router.refresh()}
        onCopy={(kind) => {
          if (blocked) void doCopy(blocked.account, kind);
        }}
        onActivate={() => {
          if (blocked) setActivateTarget(blocked.account);
        }}
        onEdit={() => {
          if (blocked) setEditTarget(blocked.account);
        }}
      />

      <MinimaxAllAccountsDialog
        open={allOpen}
        onOpenChange={setAllOpen}
        accounts={allAccounts}
        projects={orderedProjects}
        now={now}
        onCopy={(account, kind) => handleCopy(account, kind)}
        onEdit={(account) => handleEdit(account)}
        onDelete={(account) => removeAccount(account)}
      />
    </div>
  );
}
