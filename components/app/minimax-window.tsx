'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, Copy, KeyRound, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MinimaxCountdown, availableAtFromNow } from './minimax-countdown';
import {
  MinimaxAlreadyActivatedDialog,
  type MinimaxBlockedIntent,
} from './minimax-already-activated-dialog';
import { ACTIVATION_WINDOW_MS } from '@/lib/accounts/rotation';
import { WEEKLY_ACTIVATION_LIMIT, pointsForIndex } from '@/lib/accounts/weekly';
import {
  activateAccountOnly,
  copyAccountSecret,
  publishMinimaxActivated,
  type ActivateKind,
} from './minimax-activation';
import { useNowTick } from './use-now';
import type { AccountListItem, ProjectListItem } from '@/lib/services/accounts';

const NONE = '__none__';

/**
 * Очки за активацию — двумя кнопками, а не полем ввода (заказ владельца 07.11:
 * «чтобы не вручную набивать»). Обычная активация — 400 очков; 1000 бывает в
 * 4-й и 7-й день недели, и тогда оператор жмёт кнопку «1000 очков».
 *
 * КНОПКУ ПЕРЕКЛЮЧАЕТ САМА ПРОГРАММА (заказ владельца 08.11): она считает номер
 * активации в неделе аккаунта и подставляет очки по закономерности MiniMax —
 * 4-я и 7-я дают 1000, остальные 400. Владелец может переопределить кнопкой.
 */
const ACTIVATION_POINTS_CHOICES = [400, 1000] as const;

/** Зелёная кнопка — «можно нажать». */
const GREEN_BUTTON =
  'bg-emerald-600 text-white shadow-sm hover:bg-emerald-500 hover:text-white';
/** Потраченная кнопка: серая, но НАЖИМАЕМАЯ — копировать почту можно и второй раз. */
const SPENT_BUTTON =
  'bg-muted text-muted-foreground shadow-none hover:bg-muted hover:text-muted-foreground';
/** Активировано: красная и заблокированная — «всё, активировал, больше не надо». */
const DONE_BUTTON =
  'bg-destructive text-white shadow-sm opacity-80 hover:bg-destructive hover:text-white';

/**
 * Плавающее окно «Минимакса» (заказ владельца 04.11).
 *
 * Отдельное окно браузера: владелец переключается на другую вкладку, где
 * работает, и копирует почту/пароль отсюда — не возвращаясь в раздел.
 *
 * Ограничение браузера: веб-страница не может «держаться поверх» чужих
 * вкладок. Отдельное окно ОС — ближайшее возможное, и держится поверх, пока
 * оно в фокусе.
 *
 * Кнопка «Активировать этот аккаунт» гасит аккаунт БЕЗ копирования (секрет в
 * буфер не уходит) и закрывает окно; активация уходит в статистику Кармана,
 * вкладка раздела обновляется сама (BroadcastChannel).
 */
export function MinimaxWindow({
  account,
  projects,
  initialProjectId,
}: {
  account: AccountListItem;
  projects: ProjectListItem[];
  /** Проект, уже выбранный на вкладке раздела (иначе — спросим здесь). */
  initialProjectId: number | null;
}) {
  const now = useNowTick();
  const router = useRouter();
  const [project, setProject] = useState<string>(
    initialProjectId === null ? NONE : String(initialProjectId),
  );

  // Номер активации в неделе программа считает сама (неделя у аккаунта своя —
  // 7 дней от первого использования). Окно показывает его, чтобы оператор видел
  // счёт, но правит номер не здесь: точная правка — в диалоге на вкладке.
  const checkedInToday = account.weekCheckedInToday;
  const currentIndex = checkedInToday
    ? (account.weekTodayIndex ?? account.week.nextIndex ?? WEEKLY_ACTIVATION_LIMIT)
    : (account.week.nextIndex ?? WEEKLY_ACTIVATION_LIMIT);

  // Очки по умолчанию — те, что даст MiniMax за ЭТУ активацию (программа знает
  // номер: 4-я и 7-я — 1000, остальные — 400).
  const defaultPoints = checkedInToday ? account.lastTokens : pointsForIndex(currentIndex);

  const [tokens, setTokens] = useState<number>(defaultPoints);
  /** Почта/пароль уже копировались — кнопка сереет (но остаётся нажимаемой). */
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [copiedPassword, setCopiedPassword] = useState(false);
  /** Аккаунт активирован — кнопка красная и заблокированная. */
  const [activated, setActivated] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Момент активации в этом окне — для обратного отсчёта. */
  const [activatedAt, setActivatedAt] = useState<number | null>(null);
  /** Аккаунт уже погашен: что собирались нажать — копирование или активацию. */
  const [blocked, setBlocked] = useState<MinimaxBlockedIntent | null>(null);

  const projectId = project === NONE ? null : Number(project);

  /** Аккаунт уже погашен? Тогда копируем с вопросом, а не молча. */
  const spent = account.spent;

  function onReload() {
    // Страница перезагрузится: сервер отдаст свежий список, и владелец увидит
    // актуальное состояние аккаунта (окно могло истечь, пока окно висело).
    window.location.reload();
  }

  async function doCopy(kind: ActivateKind) {
    const outcome = await copyAccountSecret(account, kind);
    if (!outcome.ok) {
      toast.error(outcome.error);
      return;
    }
    setActivatedAt(Date.now());
    if (kind === 'email') setCopiedEmail(true);
    else setCopiedPassword(true);
    toast.success(kind === 'email' ? 'Почта скопирована' : 'Пароль скопирован');
  }

  async function onCopy(kind: ActivateKind) {
    if (spent) {
      setBlocked(kind === 'email' ? 'copy-email' : 'copy-password');
      // Страница могла устареть: обновляем, чтобы окно показывало актуальное
      // состояние аккаунта (заказ 05.11).
      router.refresh();
      return;
    }
    await doCopy(kind);
  }

  async function onActivate() {
    if (spent) {
      setBlocked('activate');
      router.refresh();
      return;
    }
    await activateNow();
  }

  /** Сама активация — без проверки «погашен ли аккаунт». */
  async function activateNow() {
    setBusy(true);
    try {
      // Очки идут ВМЕСТЕ с активацией (заказ владельца 05.11): раньше кнопка
      // «Активировать этот аккаунт» уходила в сервер без них, и введённое
      // число молча пропадало — не в аккаунте, не в журнале, не в статистике.
      //
      // Номер активации НЕ передаём: сервер считает его сам по недельной
      // квоте (свежее, чем страница в окне), а очки приходят выбранной
      // кнопкой.
      const outcome = await activateAccountOnly(account.id, projectId, tokens);
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      setActivated(true);
      publishMinimaxActivated(account.id);
      toast.success('Аккаунт активирован на 6 часов');
      window.close();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col gap-4 p-4">
      <div>
        <h1 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Минимакс — аккаунт
        </h1>
        <div className="text-lg font-semibold leading-tight">{account.title || '—'}</div>
        <div className="font-mono text-sm text-muted-foreground">{account.email}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          активаций: {account.activations} · очков за всё время: {account.totalTokens}
          {account.projectName ? ` · проект: ${account.projectName}` : ''}
        </div>
        {activatedAt !== null ? (
          <div className="mt-1 text-xs text-muted-foreground">
            <MinimaxCountdown
              availableAt={availableAtFromNow(activatedAt)}
              remainingMs={ACTIVATION_WINDOW_MS}
              now={now}
            />
          </div>
        ) : null}
      </div>

      {/* ПОРЯДОК ЭЛЕМЕНТОВ = порядок работы владельца (заказ 08.11: «именно в таком
          порядке я и работаю»): скопировать почту → скопировать пароль → выбрать
          проект → очки → активировать. */}
      <div className="flex flex-col gap-2">
        <Button
          variant="default"
          className={copiedEmail ? SPENT_BUTTON : GREEN_BUTTON}
          onClick={() => onCopy('email')}
          disabled={busy}
          title={copiedEmail ? 'Почта уже скопирована — можно скопировать снова' : undefined}
        >
          <Copy className="mr-1 h-4 w-4" /> Скопировать почту
        </Button>
        <Button
          variant="default"
          className={copiedPassword ? SPENT_BUTTON : GREEN_BUTTON}
          onClick={() => onCopy('password')}
          disabled={busy}
          title={copiedPassword ? 'Пароль уже скопирован — можно скопировать снова' : undefined}
        >
          <KeyRound className="mr-1 h-4 w-4" /> Скопировать пароль
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="window-project">Проект</Label>
        <Select value={project} onValueChange={setProject}>
          <SelectTrigger id="window-project">
            <SelectValue placeholder="Без проекта" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Без проекта</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Очки — кнопками, а не вводом числа (заказ владельца 07.11). Какую из
          двух подсветить — решает программа по номеру активации (08.11).
          Вид: НЕВЫБРАННАЯ — серая, ВЫБРАННАЯ — тёмная с зелёной галочкой
          (заказ 08.11: «сейчас наоборот сделано… диссонанс из-за непонятки,
          что в итоге выбрано»). */}
      <div className="flex flex-col gap-1">
        <Label>Очки за активацию</Label>
        <div className="flex gap-2">
          {ACTIVATION_POINTS_CHOICES.map((value) => {
            const selected = tokens === value;
            return (
              <Button
                key={value}
                type="button"
                variant="default"
                className={selected ? undefined : SPENT_BUTTON}
                disabled={busy || checkedInToday}
                onClick={() => setTokens(value)}
              >
                {selected ? <Check className="mr-1 h-4 w-4 text-emerald-400" /> : null}
                {value} очков
              </Button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {checkedInToday
            ? 'Сегодня чек-ин уже был — очки дня записаны, кнопки не меняются.'
            : `${currentIndex}-я активация в неделе аккаунта (сделано ${account.week.used} из ${WEEKLY_ACTIVATION_LIMIT}). Программа подставила ${defaultPoints} очков: в 4-й и 7-й день недели MiniMax даёт 1000, в остальные — 400.`}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Button
          variant="default"
          className={activated ? DONE_BUTTON : GREEN_BUTTON}
          onClick={onActivate}
          disabled={busy || activated}
        >
          <Zap className="mr-1 h-4 w-4" /> Активировать этот аккаунт
        </Button>
        <Button
          variant="default"
          className={GREEN_BUTTON}
          onClick={() => window.close()}
          disabled={busy}
        >
          Закрыть окно
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Копирование почты или пароля аккаунт <strong>не гасит</strong> — гасит только кнопка
        «Активировать этот аккаунт». Так владелец сам решает, когда аккаунт занят.
      </p>

      <MinimaxAlreadyActivatedDialog
        open={blocked !== null}
        onOpenChange={(open) => {
          if (!open) setBlocked(null);
        }}
        account={account}
        intent={blocked ?? 'copy-email'}
        now={now}
        onReload={onReload}
        onCopy={(kind) => {
          void doCopy(kind);
        }}
        onActivate={() => {
          void activateNow();
        }}
      />
    </div>
  );
}
