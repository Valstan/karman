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
import { MinimaxActivationPoints } from './minimax-activation-points';
import { ACTIVATION_WINDOW_MS } from '@/lib/accounts/rotation';
import { WEEKLY_ACTIVATION_LIMIT, pointsForIndex } from '@/lib/accounts/weekly';
import {
  activateAccountOnly,
  copyAccountSecret,
  correctActivationIndex,
  publishMinimaxActivated,
  type ActivateKind,
} from './minimax-activation';
import { useNowTick } from './use-now';
import type { AccountListItem, ProjectListItem } from '@/lib/services/accounts';

const NONE = '__none__';

/**
 * Очки за активацию — НЕМЕР АКТИВАЦИИ, а семь кнопок (заказ владельца
 * 08.11).
 *
 * Раньше было две кнопки («400 очков» / «1000 очков») и номер активации
 * считался самой программой. Владелец увидел, что программа постоянно
 * предлагает 1000, и попросил выбирать НОМЕР самому: семь кнопок, по одной на
 * клетку недели аккаунта (1-я…7-я). Очки — производная от номера: 4-я и 7-я
 * дают 1000, остальные 400.
 *
 * Программа подставляет номер по календарю недели аккаунта, но если он ошибся
 * (а журнал начат 04.11 и настоящее окно аккаунта могло начаться раньше) —
 * владелец жмёт нужную кнопку, и дальше программа считает от его номера.
 */

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
  emailCopied = false,
}: {
  account: AccountListItem;
  projects: ProjectListItem[];
  /** Проект, уже выбранный на вкладке раздела (иначе — спросим здесь). */
  initialProjectId: number | null;
  /**
   * Почта уже в буфере: быстрый путь копирует её ДО открытия окна. Кнопка
   * «Скопировать почту» тогда посеревшая (заказ владельца 12.11) — нажимать
   * её второй раз незачем, и путать владельца она не должна.
   */
  emailCopied?: boolean;
}) {
  const now = useNowTick();
  const router = useRouter();
  const [project, setProject] = useState<string>(
    initialProjectId === null ? NONE : String(initialProjectId),
  );

  // Номер активации в неделе (клетка 1..7 панели MiniMax). Программа считает
  // его по календарю недели аккаунта; владелец может назвать настоящий номер
  // сам — тогда дальше программа считает от его номера (заказ 08.11).
  //
  // Если чек-ин за сегодня уже есть, показываем ЗАПИСАННЫЙ номер (его и надо
  // поправить, если он неверен), а не предложение «на сегодня».
  const checkedInToday = account.weekCheckedInToday;
  const suggestedIndex = account.week.nextIndex ?? WEEKLY_ACTIVATION_LIMIT;
  const currentIndex = checkedInToday
    ? (account.weekTodayIndex ?? suggestedIndex)
    : suggestedIndex;

  // Очки — производная от номера: 4-я и 7-я клетки дают 1000, остальные 400.
  const [index, setIndex] = useState<number>(currentIndex);
  /** Почта/пароль уже копировались — кнопка сереет (но остаётся нажимаемой). */
  const [copiedEmail, setCopiedEmail] = useState(emailCopied);
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
      // Номер активации уходит ВМЕСТЕ с активацией (заказ владельца 08.11):
      // это клетка недели аккаунта на панели MiniMax (1..7), и очки — её
      // производная (4-я и 7-я — 1000, остальные — 400). Передавать нужно
      // ИМЕННО выбранный владельцем номер: он видел настоящую панель, а
      // программа считает по журналу, который начат 04.11 и для части
      // аккаунтов отстаёт от настоящего окна.
      const outcome = await activateAccountOnly(account.id, projectId, undefined, index);
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      setActivated(true);
      publishMinimaxActivated(account.id);
      toast.success('Аккаунт активирован на 10 часов');
      window.close();
    } finally {
      setBusy(false);
    }
  }

  /**
   * Записать номер активации для УЖЕ активированного сегодня аккаунта.
   *
   * Отдельное действие, а не повторная активация: аккаунт уже погашен, окно
   * трогать нельзя — меняется только номер клетки в журнале и очки по нему.
   */
  async function onSaveIndex() {
    setBusy(true);
    try {
      const outcome = await correctActivationIndex(account.id, index);
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      publishMinimaxActivated(account.id);
      toast.success(`Записан ${index}-й номер — ${pointsForIndex(index)} очков`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    // Весь контент — по центру окна (заказ владельца 12.11: «всё по середине
    // окна, так удобнее целиться при быстрой активации»). Колонка узкая и
    // одинаковой ширины: кнопки стоят на своих местах, а не разъезжаются по
    // левому краю.
    <div className="flex min-h-screen flex-col items-center gap-4 p-4 text-center">
      <div className="flex w-full max-w-[440px] flex-col items-center gap-4">
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
        <div className="flex w-full flex-col gap-2">
          <Button
            variant="default"
            className={copiedEmail ? SPENT_BUTTON : GREEN_BUTTON}
            onClick={() => onCopy('email')}
            disabled={busy}
            title={
              copiedEmail
                ? 'Почта уже скопирована — можно скопировать снова'
                : 'Скопировать почту в буфер обмена'
            }
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

        <div className="flex w-full flex-col gap-1">
          <Label htmlFor="window-project">Проект</Label>
          <Select value={project} onValueChange={setProject}>
            <SelectTrigger id="window-project" className="w-full justify-center">
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

        {/* НОМЕР АКТИВАЦИИ — семь кнопок в ряд (заказ владельца 08.11). Очки —
            производная от номера (4-я и 7-я клетки — 1000, остальные — 400). */}
        <MinimaxActivationPoints
          value={index}
          onChange={setIndex}
          disabled={busy}
        />
        <p className="w-full text-xs text-muted-foreground">
          {checkedInToday
            ? `Сегодня чек-ин уже был — записан ${account.weekTodayIndex ?? index}-й номер (${pointsForIndex(account.weekTodayIndex ?? index)} очков). Нажми другую кнопку, если программа ошиблась: номер и очки пересчитаются.`
            : `${index}-я активация в неделе аккаунта (сделано ${account.week.used} из ${WEEKLY_ACTIVATION_LIMIT}) — ${pointsForIndex(index)} очков. Программа считает номер по календарю недели; если в MiniMax показано иначе — нажми нужную кнопку.`}
        </p>

        <div className="flex w-full flex-col gap-2">
          <Button
            variant="default"
            className={activated ? DONE_BUTTON : GREEN_BUTTON}
            onClick={onActivate}
            disabled={busy || activated}
          >
            <Zap className="mr-1 h-4 w-4" /> Активировать этот аккаунт
          </Button>
          {/* Правка номера уже ЗАПИСАННОЙ активации (заказ владельца 08.11:
              «мало ли, если я забыл, неправильно ее поставил, или забыл вообще
              ее поменять»). Кнопка появляется, когда владелец выбрал номер,
              отличный от записанного. */}
          {checkedInToday && index !== (account.weekTodayIndex ?? index) ? (
            <Button
              variant="default"
              className={GREEN_BUTTON}
              onClick={() => void onSaveIndex()}
              disabled={busy}
            >
              <Check className="mr-1 h-4 w-4" /> Записать {index}-й номер
            </Button>
          ) : null}
          <Button
            variant="default"
            className={GREEN_BUTTON}
            onClick={() => window.close()}
            disabled={busy}
          >
            Закрыть окно
          </Button>
        </div>

        <p className="w-full text-xs text-muted-foreground">
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
    </div>
  );
}
