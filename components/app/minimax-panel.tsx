'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Copy, KeyRound, LayoutList, RefreshCw, Trash2, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  deleteAccountAction,
  deleteProjectAction,
  nextAccountAction,
} from '@/lib/actions/accounts';
import {
  ACTIVATED_PREVIEW_LIMIT,
  accountPoolSummary,
  isSpent,
  moscowToday,
  splitAccounts,
} from '@/lib/accounts/rotation';
import { cohortStats, weeklyPoolStats } from '@/lib/accounts/weekly';
import { availableByTier } from '@/lib/accounts/pool';
import { centeredWindowFeatures } from '@/lib/accounts/window-features';
import { MinimaxFormDialog } from './minimax-form-dialog';
import { MinimaxActivateDialog } from './minimax-activate-dialog';
import {
  MinimaxAlreadyActivatedDialog,
  type MinimaxBlockedIntent,
} from './minimax-already-activated-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { MinimaxToolbar } from './minimax-toolbar';
import { MinimaxAccountRow, type AccountDailyState } from './minimax-account-row';
import { MinimaxAllAccountsDialog } from './minimax-all-accounts-dialog';
import { MinimaxTokenTool } from './minimax-token-tool';
import { TOKEN_STATE_LABEL, useMinimaxTokenFlow } from './minimax-token-flow';
import { syncDailyStatesAction } from '@/lib/actions/minimax-daily';
import { MinimaxActivationsByDay } from './minimax-activations-by-day';
import { MinimaxDailySums } from './minimax-daily-sums';
import { MinimaxApiUsage } from './minimax-api-usage';
import { MinimaxAccountRating } from './minimax-account-rating';
import { MinimaxActivityChart } from './minimax-activity-chart';
import {
  copyAccountSecret,
  subscribeMinimaxActivated,
  type ActivateKind,
} from './minimax-activation';
import { useNowTick } from './use-now';
import type {
  AccountListItem,
  ApiUsageDay,
  ProjectListItem,
  ProjectUsageDay,
} from '@/lib/services/accounts';
import type { TokenProgress } from '@/lib/services/account-tokens';
import type { AccountRatingRow, DailyUsage } from '@/lib/accounts/stats';
import { sortProjectsByUsage } from '@/lib/accounts/stats';
import type { ProjectUsage } from '@/lib/accounts/rotation';

/**
 * «Минимакс» — мультиаккаунт (задача владельца 2026-11-03, экран перестроен 04.11,
 * правило и статистика изменены 05.11).
 *
 * Правило: **копирование почты или пароля НЕ гасит аккаунт** (заказ владельца
 * 05.11). Гасит только явная кнопка «Активировать». Аккаунт после активации
 * гаснет ДО НОЧНОГО СБРОСА MiniMax (мандат 15.11): суточный бонус обновляется
 * ночью, и до него аккаунт ни проекту не отдаётся, ни очков не даёт.
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
/**
 * Сводка по суточным бонусам (заказ владельца 18.11) — серверная функция отдаёт её
 * в панель prop'ом, поэтому тип здесь свой (клиентская часть не тянет server-only).
 */
export type BonusStatsView = {
  date: string;
  accounts: number;
  claimed: number;
  already: number;
  points: number;
  handed: number;
  handedPoints: number;
  spentPoints: number;
  leftPoints: number;
};

export function MinimaxPanel({
  accounts,
  projects,
  usage,
  usageByDay,
  daily,
  rating,
  apiUsage,
  tokenProgress,
  dailyStates,
  bonusStats,
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
  /** Расход по запросам проектов по дням — отдельно от расхода на программирование (14.11). */
  apiUsage: ApiUsageDay[];
  /** Состояние токенов аккаунтов (заказ 15.11: статусы «Без токена»/«Токен получен»). */
  tokenProgress: TokenProgress;
  /** Состояние суток по панели MiniMax: у кого очки реально есть (сверка 15.11). */
  dailyStates: Record<number, AccountDailyState>;
  /** Сводка по суточным бонусам (заказ владельца 18.11): забрали / отдали / потратили. */
  bonusStats: BonusStatsView;
  /** Момент, на котором сервер посчитал список (ISO) — для гидрации. */
  serverNow: string;
}) {
  const router = useRouter();

  // Добыча токенов — общий поток для карточки и кнопок «Токен» в строках
  // (заказ владельца 15.11: всё в разделе «Минимакс», одной страницы).
  const tokenFlow = useMinimaxTokenFlow();
  const tokenStates = useMemo(() => {
    const map = new Map<number, TokenProgress['rows'][number]>();
    for (const row of tokenProgress.rows) map.set(row.account_id, row);
    return map;
  }, [tokenProgress]);

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

  // Сколько СВОБОДНЫХ аккаунтов каждого очкового класса — для двух кнопок выдачи
  // (заказ владельца 18.11). В счёт идут только аккаунты с добытой парой токенов:
  // без пары отдавать нечего (вход в MiniMax делает владелец).
  const available = useMemo(() => {
    const ready = [...tokenStates.values()]
      .filter((row) => row.state === 'obtained')
      .map((row) => row.account_id);
    return availableByTier(accounts, new Date(clockMs), ready);
  }, [accounts, clockMs, tokenStates]);

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
        usageByDay.map((day) => ({ usedOn: day.usedOn, activations: day.activations, tokens: day.tokens })),
        moscowToday(new Date(clockMs)),
      ),
    [accounts, usageByDay, clockMs],
  );

  // Здоровье когорты (стратегия владельца 11.11): живые серии вчера, сколько
  // продолжено сегодня, сколько под риском и сколько это стоит в очках.
  const cohort = useMemo(
    () =>
      cohortStats(
        accounts.map((account) => ({
          id: account.id,
          spent: account.spent,
          releasesAt: account.availableAt,
          checkedInToday: account.weekCheckedInToday,
          quota: account.week,
        })),
        moscowToday(new Date(clockMs)),
      ),
    [accounts, clockMs],
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
   *
   * Окно открывается ПО ЦЕНТРУ экрана (заказ владельца 12.11) — считать
   * приходится вручную: браузер центрирует только «в пределах экрана», а на
   * втором мониторе окно уехало бы на основной. Геометрия — в
   * `lib/accounts/window-features.ts` (с гейтом).
   *
   * `emailCopied` — почта уже в буфере (быстрый путь копирует её ДО открытия
   * окна). Окно покажет кнопку «Скопировать почту» посеревшей, чтобы не
   * путать: второй раз нажимать незачем (заказ владельца 12.11).
   */
  function openWindow(accountId: number, options?: { emailCopied?: boolean }) {
    const params = new URLSearchParams({ accountId: String(accountId) });
    if (options?.emailCopied) params.set('copied', 'email');
    const features = centeredWindowFeatures({
      x: window.screenX,
      y: window.screenY,
      width: window.outerWidth,
      height: window.outerHeight,
    });
    const opened = window.open(
      `/minimax-window?${params.toString()}`,
      'karman-minimax-window',
      features,
    );
    if (!opened) {
      toast.error('Браузер заблокировал всплывающее окно — разрешите окна для этого сайта');
      return;
    }
    opened.focus();
  }

  /**
   * Быстрый путь к активации (заказ владельца 08.11): нажал на предложенный
   * аккаунт — сразу открылось «быстрое окно», и почта уже в буфере.
   *
   * ПЕРЕД этим — проверка свежести: страница могла устареть (активация на
   * другой машине), и тогда предложенный аккаунт уже погашен. Поэтому
   * «кто сейчас следующий» перечитывается с сервера, и окно открывается уже
   * для СВЕЖЕГО аккаунта — того, что дольше всех не активировался.
   */
  async function openNextAccountWindow(tier?: 'points_400' | 'points_1000') {
    const outcome = await nextAccountAction(tier);
    if (!outcome.ok) {
      toast.error(outcome.error);
      return;
    }
    const fresh = outcome.data;
    if (!fresh) {
      toast.info(
        tier === 'points_1000'
          ? 'Тысячных на сегодня закончились'
          : tier === 'points_400'
            ? 'Четырёхсотовых на сегодня закончились'
            : 'Свободных аккаунтов нет — все погашены или недели исчерпаны',
      );
      router.refresh();
      return;
    }
    // Почта — в буфер сразу: чтобы снова не щелкать мышкой. Окно открывается и
    // если копирование не вышло (буфер может быть недоступен) — но тогда
    // владельцу об этом сказать надо.
    const copied = await copyAccountSecret({ id: fresh.id, email: fresh.email }, 'email');
    if (!copied.ok) toast.error(copied.error);
    // Почта уже в буфере — окно покажет кнопку «Скопировать почту» посеревшей
    // (заказ владельца 12.11). Если копирование не вышло — кнопка остаётся
    // зелёной: иначе окно соврёт, что почта уже скопирована.
    openWindow(fresh.id, { emailCopied: copied.ok });
    router.refresh();
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

  // Сверка суток с панелью: идёт в фоне (после ответа сервера), поэтому страницу
  // обновляем по таймеру — иначе состояние появилось бы только после ручного F5.
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [syncing, router]);

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
          <MinimaxToolbar onAccountCreated={(id) => tokenFlow.start(id)} />

          {/* Сверка суток с панелью MiniMax: читаем, сколько очков у кого реально
              есть. Проверка ничего не тратит (очки начисляет claim) — зато видно,
              кого можно отдавать потребителю, а у кого бонус уже сожжён. */}
          <Button
            variant="outline"
            size="sm"
            disabled={syncing}
            onClick={() => {
              setSyncing(true);
              void syncDailyStatesAction().then((result) => {
                if (!result.ok) {
                  toast.error(result.error);
                  setSyncing(false);
                  return;
                }
                toast.success('Сверка идёт — состояние появится в строках через минуту');
                window.setTimeout(() => setSyncing(false), 90_000);
              });
            }}
          >
            <RefreshCw className="mr-1 h-4 w-4" />
            {syncing ? 'Сверяем сутки…' : 'Сверить сутки с MiniMax'}
          </Button>

          {/* Токены аккаунтов — здесь же, на странице «Минимакс» (заказ 15.11:
              отдельной страницы «Токены аккаунтов MiniMax» больше нет). */}
          <MinimaxTokenTool progress={tokenProgress} flow={tokenFlow} />

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

          {/* Расход по запросам проектов — отдельно от расхода на программирование
              (заказ владельца 14.11): по дням, сколько аккаунтов и очков ушло на волны. */}
          <MinimaxApiUsage days={apiUsage} />

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
              квота (заказ 09.11): «За день - X (в ближайшие 5 ч - Y)»,
              «За неделю - Z (W очков, сброс <дата>)». И прогноз по ТЕМПУ
              ПОТРЕБЛЕНИЯ (заказ владельца 16.11): темп берётся не по текущей
              неделе (в её первый день срез из одних суток — случайная цифра),
              а по срезу последних 10 полных суток; «хватит ли на неделю» —
              покрывает ли недельный запас неделю потребления. */}
          {/* Две кнопки выдачи — по очковому классу (заказ владельца 18.11): одна
              отдаёт аккаунты на 400 очков, другая — на 1000. Если аккаунтов
              соответствующего класса нет, кнопка так и говорит: «На сегодня
              закончились». */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={available.points_400 > 0 ? 'default' : 'outline'}
              disabled={available.points_400 === 0}
              onClick={() => void openNextAccountWindow('points_400')}
              title="Выдать аккаунт на 400 очков (откроется быстрое окно, почта скопируется сама)"
            >
              {available.points_400 > 0
                ? `Выдать 400-очковый (${available.points_400})`
                : 'На сегодня закончились'}
            </Button>
            <Button
              variant={available.points_1000 > 0 ? 'default' : 'outline'}
              disabled={available.points_1000 === 0}
              onClick={() => void openNextAccountWindow('points_1000')}
              title="Выдать аккаунт на 1000 очков (бонусная клетка)"
            >
              {available.points_1000 > 0
                ? `Выдать 1000-очковый (${available.points_1000})`
                : 'На сегодня закончились'}
            </Button>
          </div>
          <div className="text-sm font-medium text-muted-foreground">
            Живых аккаунтов - {pool.free}, За день - {week.today}
            {week.freesIn5h > 0 ? ` (в ближайшие 5 ч - ${week.freesIn5h})` : ''},
            За неделю - {week.week} ({week.weekPoints} очков, сброс {week.weekResetsOn})
            {week.pointsPerDay !== null
              ? ` · темп ${Math.round(week.pointsPerDay).toLocaleString('ru-RU')} очков/день (срез ${week.sliceFrom}—${week.sliceTo})`
              : ''}
            {week.coversWeek === null
              ? ''
              : week.coversWeek
                ? ' (на неделю хватает)'
                : ' (на неделю НЕ хватает)'}
          </div>
          {cohort.liveYesterday > 0 ? (
            <div className="-mt-3 text-sm font-medium text-muted-foreground">
              Живых серий вчера — {cohort.liveYesterday}, продолжено сегодня —
              {cohort.continuedToday}, не отмечены сегодня — {cohort.atRisk}
              {cohort.atRisk > 0
                ? ` (если пропустить — минус ${cohort.pointsLostIfSkipped} очков)`
                : ''}
              {cohort.bonusToday > 0 ? ` · сегодня доступно тысячных: ${cohort.bonusToday}` : ''}
            </div>
          ) : null}
          {bonusStats.accounts > 0 ? (
            <div className="-mt-3 text-sm font-medium text-muted-foreground">
              Бонусы за {bonusStats.date}: забрано у {bonusStats.accounts} аккаунтов на{' '}
              {bonusStats.points.toLocaleString('ru-RU')} очков, отдано {bonusStats.handed} (
              {bonusStats.handedPoints.toLocaleString('ru-RU')} очк.), потрачено{' '}
              {bonusStats.spentPoints.toLocaleString('ru-RU')}, осталось{' '}
              {bonusStats.leftPoints.toLocaleString('ru-RU')}
            </div>
          ) : null}
          <p className="-mt-4 text-xs text-muted-foreground">
            Окно активации — до ночного сброса (03:00 МСК), а в 05:00 МСК мы забираем
            бонусы у ВСЕХ аккаунтов (утренний обход) — с этого момента серия дней подряд не
            рвётся ни у кого, и очки лежат готовыми к выдаче.
            Номер активации — серия дней подряд: отмечен вчера — вторая клетка, пропущен
            вчера — серия сгорела, снова первая. Недельная квота — календарная неделя
            (понедельник — воскресенье), лимиты обнуляются в ночь на понедельник.
            Очки: 400 за активацию, в 4-й и 7-й — 1000. «За неделю» — сколько активаций
            ещё осталось в календарной неделе, «хватит на N дней» — при текущем темпе
            (активаций в день за эту московскую неделю).
          </p>

          {/* Верхний слот: ОДИН следующий аккаунт. Вся карточка слева — одна
              большая кнопка (заказ владельца 08.11: «нажал в любом месте —
              открылось быстрое окно, и почта уже в буфере»). Перед открытием
              состояние перечитывается с сервера: страница могла устареть, и
              тогда предложенный аккаунт уже погашен — окно откроется для
              свежего «самого старого неактивированного». */}
          <div className="rounded-md border border-emerald-500/50 bg-emerald-500/10 p-4">
            {next ? (
              <div className="flex flex-wrap items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => void openNextAccountWindow()}
                  title="Открыть быстрое окно: почта скопируется сама"
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Следующий аккаунт
                  </div>
                  <div className="mt-1 block max-w-full truncate text-lg font-semibold hover:underline">
                    {next.title || '—'}
                  </div>
                  <div className="font-mono text-sm text-muted-foreground">{next.email}</div>
                  {/* Сводка по аккаунту (заказ 05.11): верхний слот тоже может быть
                      не новым — у него есть история активаций. */}
                  {next.activations > 0 ? (
                    <div className="text-xs text-muted-foreground">
                      активаций: {next.activations}
                      {next.totalTokens > 0 ? ` · очков всего: ${next.totalTokens}` : ''}
                      {next.weekUsed > 0 ? ` · на этой неделе: ${next.weekUsed} из 7` : ''}
                    </div>
                  ) : null}
                  {/* Что даст ближайшая активация этого аккаунта: клетка и
                      очки (заказ владельца 11.11 — верхний слот выбирается по
                      деньгам, а не по давноте). */}
                  <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                    {next.week.pointsToday > 0
                      ? `клетка ${next.week.nextIndex ?? '—'} — ${next.week.pointsToday} очков${
                          next.week.pointsToday === 1000
                            ? ' (бонус)'
                            : ` · до 1000 через ${next.week.daysToBonus - 1} дн.`
                        }`
                      : 'сегодня чек-ин уже был — очков сегодня не даст'}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Токен:{' '}
                    {tokenStates.get(next.id)
                      ? TOKEN_STATE_LABEL[tokenStates.get(next.id)!.state]
                      : '—'}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Нажми — откроется окно, почта скопируется сама
                  </div>
                </button>
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
                    title="Активировать аккаунт: погаснет до ночного сброса MiniMax"
                    onClick={() => handleActivate(next)}
                  >
                    <Zap className="mr-1 h-4 w-4" /> Активировать
                  </Button>
                  {/* «В окне» убран 08.11: открыть окно теперь можно нажатием на
                      саму карточку аккаунта (слева), и почта копируется сама. */}
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
                  serverNow={serverNow}
                  projects={orderedProjects}
                  onCopy={(kind) => handleCopy(account, kind)}
                  onEdit={() => handleEdit(account)}
                  onDelete={() => removeAccount(account)}
                  onOpenWindow={() => openWindow(account.id)}
                  onGetToken={(id) => tokenFlow.start(id)}
                  tokenState={tokenStates.get(account.id)?.state}
                  dailyState={dailyStates[account.id]}
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
        tokenStates={tokenStates}
        onGetToken={(id) => tokenFlow.start(id)}
        onCopy={(account, kind) => handleCopy(account, kind)}
        onEdit={(account) => handleEdit(account)}
        onDelete={(account) => removeAccount(account)}
      />
    </div>
  );
}
