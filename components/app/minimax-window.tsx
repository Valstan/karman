'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Copy, KeyRound, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { ACTIVATION_WINDOW_MS, DEFAULT_ACTIVATION_TOKENS } from '@/lib/accounts/rotation';
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
  const [tokens, setTokens] = useState(String(DEFAULT_ACTIVATION_TOKENS));
  const [busy, setBusy] = useState(false);
  /** Момент активации в этом окне — для обратного отсчёта. */
  const [activatedAt, setActivatedAt] = useState<number | null>(null);
  /** Аккаунт уже погашен: что собирались нажать — копирование или активация. */
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
    setTokens(String(DEFAULT_ACTIVATION_TOKENS));
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
      // Токены из поля идут ВМЕСТЕ с активацией (заказ владельца 05.11): раньше
      // кнопка «Активировать этот аккаунт» уходила в сервер без них, и введённое
      // число молча пропадало — не в аккаунте, не в журнале, не в статистике.
      const raw = tokens.trim();
      const outcome = await activateAccountOnly(
        account.id,
        projectId,
        raw === '' ? undefined : Number(raw),
      );
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      publishMinimaxActivated(account.id);
      toast.success('Аккаунт активирован на 24 часа');
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
          активаций: {account.activations} · токенов за всё время: {account.totalTokens}
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

      <div className="flex flex-col gap-1">
        <Label htmlFor="window-tokens">
          Токены за активацию (по умолчанию {DEFAULT_ACTIVATION_TOKENS})
        </Label>
        <Input
          id="window-tokens"
          type="number"
          min={0}
          inputMode="numeric"
          placeholder="0"
          value={tokens}
          onChange={(e) => setTokens(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Button onClick={() => onCopy('email')} disabled={busy}>
          <Copy className="mr-1 h-4 w-4" /> Скопировать почту
        </Button>
        <Button variant="outline" onClick={() => onCopy('password')} disabled={busy}>
          <KeyRound className="mr-1 h-4 w-4" /> Скопировать пароль
        </Button>
        <Button variant="secondary" onClick={onActivate} disabled={busy}>
          <Zap className="mr-1 h-4 w-4" /> Активировать этот аккаунт
        </Button>
        <Button variant="ghost" onClick={() => window.close()} disabled={busy}>
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
