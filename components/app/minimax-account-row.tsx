'use client';

import { Copy, ExternalLink, KeyRound, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MinimaxCountdown, formatAvailableAt } from './minimax-countdown';
import { MinimaxFormDialog } from './minimax-form-dialog';
import { ConfirmDialog } from './confirm-dialog';
import type { ActivateKind } from './minimax-activation';
import type { AccountListItem, ProjectListItem } from '@/lib/services/accounts';

/**
 * Компактная строка аккаунта: название с почтой, кнопки «Почта»/«Пароль»,
 * «Правка» и корзинка. Под названием — обратный отсчёт до освобождения
 * (04.11: «сколько времени осталось»).
 *
 * Строка израсходованного аккаунта подкрашена красным, свободного — зелёным.
 */
export function MinimaxAccountRow({
  account,
  spent,
  now,
  onCopy,
  onEdit,
  onDelete,
  onOpenWindow,
  projects,
}: {
  account: AccountListItem;
  /** Аккаунт израсходован (окно 24 ч не истекло) — строка гаснет. */
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
  /** Проекты — для смены проекта в правке. */
  projects?: ProjectListItem[];
}) {
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
