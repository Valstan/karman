'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { LayoutList, Trash2 } from 'lucide-react';
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
  accountPoolSummary,
  isSpent,
  moscowToday,
  splitAccounts,
} from '@/lib/accounts/rotation';
import { cohortStats, weeklyPoolStats } from '@/lib/accounts/weekly';
import { availableByTier, poolTierOf } from '@/lib/accounts/pool';
import { centeredWindowFeatures } from '@/lib/accounts/window-features';
import { MinimaxFormDialog } from './minimax-form-dialog';
import { MinimaxActivateDialog } from './minimax-activate-dialog';
import {
  MinimaxAlreadyActivatedDialog,
  type MinimaxBlockedIntent,
} from './minimax-already-activated-dialog';
import { MinimaxToolbar } from './minimax-toolbar';
import { MinimaxAllAccountsDialog } from './minimax-all-accounts-dialog';
import { MinimaxStatisticsGrid } from './minimax-statistics-grid';
import { useMinimaxTokenFlow } from './minimax-token-flow';
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

  // Сколько сегодня дадут тысячные очков — по ТОЙ ЖЕ правде, что и кнопки выдачи
  // (в когорте было «по модели» — 61 против 30, и владелец видел два разных
  // числа об одном и том же: модель клетки с панелью расходится у 42 аккаунтов
  // из 112 — живьём 16.11).
  const bonusToday = useMemo(
    () => accounts.filter((account) => poolTierOf(account, new Date(clockMs)) === 'points_1000').length,
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
      {/* КНОПКИ — по центру сверху (заказ владельца 18.11): добавление и выдача
          одним рядом, а под ними — блок статистики в трёх столбцах, разделы
          которых можно перетаскивать мышью. */}
      <div className="flex flex-col items-center gap-3">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <MinimaxToolbar onAccountCreated={(id) => tokenFlow.start(id)} />
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
          <Button variant="outline" size="sm" onClick={() => setAllOpen(true)}>
            <LayoutList className="mr-1 h-4 w-4" /> Показать все аккаунты
          </Button>
        </div>
        <p className="max-w-3xl text-center text-xs text-muted-foreground">
          Окно активации — до ночного сброса (03:00 МСК), а в 05:00 МСК мы забираем бонусы у
          ВСЕХ аккаунтов (утренний обход) — с этого момента серия дней подряд не рвётся ни у
          кого, и очки лежат готовыми к выдаче. Номер активации — серия дней подряд: отмечен
          вчера — вторая клетка, пропущен вчера — серия сгорела, снова первая. Недельная квота —
          календарная неделя (понедельник — воскресенье), лимиты обнуляются в ночь на
          понедельник. Очки: 400 за активацию, в 4-й и 7-й — 1000.
        </p>
      </div>

      {/* Статистика — три столбца, разделы перетаскиваются (заказ владельца 18.11:
          «все разделы статистики сделай перетаскиваемыми вручную, чтобы я сам мог их
          располагать на странице как мне удобно смотреть»). */}
      <MinimaxStatisticsGrid
        sections={[
          {
            id: 'pool',
            title: 'Пул и бонусы',
            node: (
              <div className="flex flex-col gap-2">
                <div className="text-sm font-medium text-muted-foreground">
                  Живых аккаунтов - {pool.free}, За день - {week.today}
                  {week.freesIn5h > 0 ? ` (в ближайшие 5 ч - ${week.freesIn5h})` : ''}, За неделю -{' '}
                  {week.week} ({week.weekPoints} очков, сброс {week.weekResetsOn})
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
                  <div className="text-sm font-medium text-muted-foreground">
                    Живых серий вчера — {cohort.liveYesterday}, продолжено сегодня —{' '}
                    {cohort.continuedToday}, не отмечены сегодня — {cohort.atRisk}
                    {cohort.atRisk > 0
                      ? ` (если пропустить — минус ${cohort.pointsLostIfSkipped} очков)`
                      : ''}
                    {bonusToday > 0 ? ` · сегодня доступно тысячных: ${bonusToday}` : ''}
                  </div>
                ) : null}
                {bonusStats.accounts > 0 ? (
                  <div className="text-sm font-medium text-muted-foreground">
                    Бонусы за {bonusStats.date}: забрали у {bonusStats.claimed} аккаунтов на{' '}
                    {bonusStats.points.toLocaleString('ru-RU')} очков; у {bonusStats.already} клетку
                    забрал потребитель — эти {bonusStats.spentPoints.toLocaleString('ru-RU')} очков
                    потрачены и в выдачу не идут; отдано {bonusStats.handed} (
                    {bonusStats.handedPoints.toLocaleString('ru-RU')} очк.), на аккаунтах лежит{' '}
                    {bonusStats.leftPoints.toLocaleString('ru-RU')}
                  </div>
                ) : null}
              </div>
            ),
          },
          {
            id: 'usage',
            title: 'Расход по проектам',
            node: (
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
            ),
          },
          {
            id: 'api',
            title: 'Расход по запросам',
            node: <MinimaxApiUsage days={apiUsage} />,
          },
          {
            id: 'sums',
            title: 'Суммы по дням',
            node: <MinimaxDailySums days={daily} serverNow={serverNow} />,
          },
          {
            id: 'byDay',
            title: 'Активации по дням',
            node: <MinimaxActivationsByDay rows={usageByDay} />,
          },
          {
            id: 'rating',
            title: 'Рейтинг аккаунтов',
            node: <MinimaxAccountRating rows={rating} />,
          },
          {
            id: 'chart',
            title: 'Активность за 90 дней',
            node: <MinimaxActivityChart days={daily} serverNow={serverNow} />,
          },
          {
            id: 'projects',
            title: 'Проекты',
            node: (
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
                    Проектов пока нет — добавьте первый кнопкой «Добавить проект» сверху.
                  </p>
                )}
              </div>
            ),
          },
        ]}
      />

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
