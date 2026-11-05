'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MinimaxCountdown, formatAvailableAt } from './minimax-countdown';
import type { AccountListItem } from '@/lib/services/accounts';

/**
 * «Аккаунт уже активирован» (заказ владельца 05.11).
 *
 * Зачем: страница раздела иногда не обновляется, и владелец жмёт «Почта» на
 * аккаунте, который уже погашен. Раньше это было молча — копирование гасило
 * аккаунт заново. Теперь копирование не гасит ничего, но владельцу всё равно
 * нужно понять: он взял не тот аккаунт (страница устарела) или ему правда
 * нужно скопировать пароль ещё раз.
 *
 * Поэтому модалка не просто предупреждает, а СПРАШИВАЕТ, что делать:
 * обновить страницу (тогда сверху встанет свежий, неактивированный аккаунт),
 * всё равно скопировать / активировать, или просто открыть правку аккаунта —
 * правка страницу не перезагружает и новые аккаунты наверх не вытаскивает.
 */

/** Что владелец хотел сделать, когда нажал на уже активированный аккаунт. */
export type MinimaxBlockedIntent = 'copy-email' | 'copy-password' | 'activate' | 'edit';

export function MinimaxAlreadyActivatedDialog({
  open,
  onOpenChange,
  account,
  intent,
  now,
  onReload,
  onCopy,
  onActivate,
  onEdit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: AccountListItem | null;
  intent: MinimaxBlockedIntent;
  /** Клиентские часы; null — показываем серверное значение. */
  now: number | null;
  /** Перезагрузить страницу: сверху встанет свежий неактивированный аккаунт. */
  onReload: () => void;
  /** Всё равно скопировать (только для намерения «копирование»). */
  onCopy?: (kind: 'email' | 'password') => void;
  /** Всё равно активировать (только для намерения «активация»). */
  onActivate?: () => void;
  /** Открыть правку аккаунта: страницу не перезагружает. */
  onEdit?: () => void;
}) {
  if (!account) return null;

  const copyKind =
    intent === 'copy-email' ? 'email' : intent === 'copy-password' ? 'password' : null;

  const description = (() => {
    const name = `«${account.title || account.email}»`;
    if (intent === 'activate') {
      return `${name} уже погашен: новая активация продолжит ту же сессию, а не откроет
        новую. Возможно, страница просто не обновилась и сверху уже другой аккаунт.`;
    }
    if (intent === 'edit') {
      return `${name} уже погашен. Правка ничего не гасит и страницу не перезагружает —
        но, возможно, страница устарела и сверху уже другой аккаунт.`;
    }
    return `${name} уже погашен — копирование его больше не активирует и окно не продлевает.
      Возможно, страница просто не обновилась и сверху уже другой аккаунт.`;
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Аккаунт уже активирован</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {account.availableAt ? (
          <div className="text-sm text-muted-foreground">
            <MinimaxCountdown
              availableAt={account.availableAt}
              remainingMs={account.remainingMs}
              now={now}
            />{' '}
            · освободится {formatAvailableAt(account.availableAt)}
          </div>
        ) : null}
        <DialogFooter className="flex-wrap">
          <Button
            onClick={() => {
              onReload();
              onOpenChange(false);
            }}
          >
            Обновить страницу
          </Button>
          {copyKind && onCopy ? (
            <Button
              variant="outline"
              onClick={() => {
                onCopy(copyKind);
                onOpenChange(false);
              }}
            >
              {copyKind === 'email' ? 'Всё равно скопировать почту' : 'Всё равно скопировать пароль'}
            </Button>
          ) : null}
          {intent === 'activate' && onActivate ? (
            <Button
              variant="outline"
              onClick={() => {
                onActivate();
                onOpenChange(false);
              }}
            >
              Всё равно активировать
            </Button>
          ) : null}
          {onEdit ? (
            <Button
              variant="outline"
              onClick={() => {
                onEdit();
                onOpenChange(false);
              }}
            >
              Правка аккаунта
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
        </DialogFooter>
        <p className="text-xs text-muted-foreground">
          Обновление страницы вытащит наверх следующий свободный аккаунт. Правка —
          ничего не перезагружает.
        </p>
      </DialogContent>
    </Dialog>
  );
}
