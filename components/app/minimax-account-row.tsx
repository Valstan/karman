'use client';

import { Copy, ExternalLink, KeyRound, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MinimaxCountdown, formatAvailableAt } from './minimax-countdown';
import { MinimaxFormDialog } from './minimax-form-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { TOKEN_STATE_LABEL } from './minimax-token-flow';
import type { ActivateKind } from './minimax-activation';
import type { AccountListItem, ProjectListItem } from '@/lib/services/accounts';

/**
 * Состояние суток аккаунта по панели MiniMax (прочитано сверкой, очки не тратим).
 */
export type AccountDailyState = {
  /** Можно ли забрать очки прямо сейчас. */
  can_claim: boolean;
  /** Сколько очков даст сегодняшняя клетка. */
  points: number;
  /** Статус клетки: 1 — не начался, 2 — можно забрать, 3 — забрано. */
  status: number;
  /** Номер сегодняшней клетки по панели (1..7). */
  cell_no: number;
  /** Когда прочитали (ISO). */
  checked_at: string;
  /**
   * Протух ли ответ панели (старше получаса). Тогда это «не знаю», а не правда:
   * показываем отдельно, чтобы владелец не принял давний ответ за сегодняшний.
   */
  stale: boolean;
};

/**
 * Компактная строка аккаунта: название с почтой, статус токена, кнопки
 * «Почта»/«Пароль», «Правка» и корзинка. Под названием — обратный отсчёт до
 * освобождения (04.11: «сколько времени осталось»).
 *
 * Строка с сожжённым бонусом подкрашена красным, свободного — зелёным.
 *
 * Токен аккаунта — в одном месте со всем остальным (заказ владельца 15.11: «пусть
 * там будет аккаунт мини макса, в котором будут и его активации, его токен, его
 * почта, его пароль»). Статусов ровно два — «Без токена» и «Токен получен»; если
 * токена нет, рядом кнопка «Токен»: получить его, не выходя из раздела.
 */
export function MinimaxAccountRow({
  account,
  spent,
  now,
  onCopy,
  onEdit,
  onDelete,
  onOpenWindow,
  onGetToken,
  tokenState,
  dailyState,
  projects,
}: {
  account: AccountListItem;
  /** Аккаунт с сожжённым бонусом (ночной сброс ещё не наступил) — строка гаснет. */
  spent: boolean;
  /** Клиентские часы; null — показываем серверное значение. */
  now: number | null;
  /** Копирование — гасить аккаунт больше не входит сюда (заказ 05.11). */
  onCopy: (kind: ActivateKind) => void;
  /** Правка: если задана — вызывает её, иначе открывается свой диалог. */
  onEdit?: () => void;
  onDelete: () => void | Promise<void>;
  /** Открыть в отдельном окне поверх вкладок. */
  onOpenWindow?: () => void;
  /** Получить токен этого аккаунта (device-flow). */
  onGetToken?: (accountId: number) => void;
  /** Статус токена аккаунта: «Без токена» или «Токен получен». */
  tokenState?: 'none' | 'obtained';
  /** Состояние суток по панели MiniMax: у кого очки реально есть (сверка 15.11). */
  dailyState?: AccountDailyState;
  projects?: ProjectListItem[];
}) {
  // Свежий ответ панели — источник правды; протухший — «не знаю».
  const panel = dailyState && !dailyState.stale ? dailyState : null;
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2 ${
        spent ? 'bg-destructive/10' : 'bg-emerald-500/10'
      }`}
    >
      <div className="min-w-0">
        <div className="truncate font-medium leading-tight">{account.title || '—'}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">{account.email}</div>
        {spent ? (
          <div className="text-xs text-muted-foreground">
            <MinimaxCountdown
              availableAt={account.availableAt}
              remainingMs={account.remainingMs}
              now={now}
            />
            {account.availableAt ? ` · освободится ${formatAvailableAt(account.availableAt)}` : ''}
          </div>
        ) : null}
        {/* Что даст ближайшая активация: клетка и очки (заказ владельца 11.11).
            Ответ панели MiniMax — источник правды (16.11): если он свежий, берём
            его клетку и очки, а не модель по датам. */}
        <div className="text-xs text-muted-foreground">
          {panel && panel.can_claim ? (
            `клетка ${panel.cell_no || '—'} — ${panel.points} очков (панель MiniMax)`
          ) : panel ? (
            'панель MiniMax: очки сегодня уже сожжены'
          ) : account.week.pointsToday > 0 ? (
            `клетка ${account.week.nextIndex ?? '—'} — ${account.week.pointsToday} очков${
              account.week.pointsToday === 1000
                ? ' (бонус)'
                : ` · до 1000 через ${account.week.daysToBonus - 1} дн.`
            }`
          ) : (
            'сегодня чек-ин уже был — очков сегодня не даст'
          )}
        </div>
        {/* Токен аккаунта — ровно два статуса (заказ владельца 15.11). */}
        <div className="text-xs text-muted-foreground">
          Токен: {tokenState ? TOKEN_STATE_LABEL[tokenState] : '—'}
        </div>
        {/* Ответ панели MiniMax — прочитан без траты очков (сверка 15.11, автосверка 16.11). */}
        {dailyState ? (
          <div className="text-xs text-muted-foreground">
            {dailyState.stale
              ? `панель MiniMax: ответ устарел (${formatCheckedAt(dailyState.checked_at)}) — ждём сверки`
              : `панель MiniMax: ${
                  dailyState.can_claim ? `очки есть: ${dailyState.points}` : 'очки сожжены — ждём сброса'
                } (${formatCheckedAt(dailyState.checked_at)})`}
          </div>
        ) : null}
        {/* Заказ владельца 05.11: по аккаунту — на какой проект он активирован,
            сколько очков ушло и сколько раз его брали. */}
        <div className="text-xs text-muted-foreground">
          {account.projectName ? `проект: ${account.projectName} · ` : 'без проекта · '}
          {account.lastTokens > 0 ? `очков за активацию: ${account.lastTokens} · ` : ''}
          активаций: {account.activations}
          {account.totalTokens > 0 ? ` · очков всего: ${account.totalTokens}` : ''}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          title="Скопировать почту (аккаунт не гаснет)"
          onClick={() => onCopy('email')}
        >
          <Copy className="mr-1 h-4 w-4" /> Почта
        </Button>
        <Button
          variant="outline"
          size="sm"
          title="Скопировать пароль (аккаунт не гаснет)"
          onClick={() => onCopy('password')}
        >
          <KeyRound className="mr-1 h-4 w-4" /> Пароль
        </Button>
        {tokenState === 'none' && onGetToken ? (
          <Button
            variant="outline"
            size="sm"
            title="Получить токен этого аккаунта (вход в MiniMax в браузере)"
            onClick={() => onGetToken(account.id)}
          >
            <KeyRound className="mr-1 h-4 w-4" /> Токен
          </Button>
        ) : null}
        {onOpenWindow ? (
          <Button
            variant="outline"
            size="sm"
            title="Открыть в отдельном окне — копировать, не переключаясь между вкладками"
            onClick={onOpenWindow}
          >
            <ExternalLink className="mr-1 h-4 w-4" /> В окне
          </Button>
        ) : null}
        {onEdit ? (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Правка
          </Button>
        ) : (
          <MinimaxFormDialog
            account={account}
            projects={projects}
            trigger={
              <Button variant="ghost" size="sm">
                Правка
              </Button>
            }
          />
        )}
        <ConfirmDialog
          title="Удалить аккаунт?"
          description={`«${account.title || account.email}» будет удалён вместе с историей активаций.`}
          onConfirm={onDelete}
          trigger={
            <Button variant="ghost" size="icon" aria-label="Удалить аккаунт">
              <Trash2 className="h-4 w-4" />
            </Button>
          }
        />
      </div>
    </div>
  );
}

/**
 * Когда панель читали — часами и минутами клиента («проверено 12:40»).
 *
 * Время московское у владельца, но браузер может быть в другом поясе — поэтому
 * подпись «в 12:40» без указания пояса вводила бы в заблуждение. Показываем
 * относительное время: «проверено 12 мин назад» — его нельзя прочитать неверно.
 */
function formatCheckedAt(checkedAt: string): string {
  const checked = new Date(checkedAt).getTime();
  if (Number.isNaN(checked)) return 'когда-то';
  const minutes = Math.max(0, Math.round((Date.now() - checked) / 60_000));
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}
