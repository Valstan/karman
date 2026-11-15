'use client';

import { Copy, KeyRound, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MinimaxCountdown } from './minimax-countdown';
import { MinimaxFormDialog } from './minimax-form-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { TOKEN_STATE_LABEL } from './minimax-token-flow';
import { isSpent } from '@/lib/accounts/rotation';
import type { ActivateKind } from './minimax-activation';
import type { AccountListItem, ProjectListItem } from '@/lib/services/accounts';

/**
 * Полный список аккаунтов (кнопка «показать все аккаунты»).
 *
 * Основной список показывает только верхний слот и последние активированные —
 * «чтобы не мешать» (04.11). Здесь — всё: видно, кто активирован, кто свободен,
 * есть ли токен, и можно правку или удаление любого.
 *
 * Статус токена — ровно два (заказ владельца 15.11): «Без токена» и «Токен
 * получен». У аккаунта без токена есть кнопка — получить его прямо отсюда.
 */
export function MinimaxAllAccountsDialog({
  open,
  onOpenChange,
  accounts,
  projects,
  now,
  tokenStates,
  onGetToken,
  onCopy,
  onEdit,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: AccountListItem[];
  projects: ProjectListItem[];
  now: number | null;
  /** Статус токена по аккаунту: «Без токена» или «Токен получен» (заказ 15.11). */
  tokenStates?: Map<number, { state: 'none' | 'obtained' }>;
  /** Получить токен аккаунта (device-flow). */
  onGetToken?: (accountId: number) => void;
  /** Копирование — гасить аккаунт больше не входит сюда (заказ 05.11). */
  onCopy: (account: AccountListItem, kind: ActivateKind) => void;
  /** Правка: раздел перехватывает и спрашивает, что делать с погашенным. */
  onEdit?: (account: AccountListItem) => void;
  onDelete: (account: AccountListItem) => void | Promise<void>;
}) {
  const clock = now === null ? new Date() : new Date(now);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Все аккаунты</DialogTitle>
          <DialogDescription>
            Полный список: кто активирован, кто свободен, у кого есть токен. Здесь же —
            правка и удаление.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Аккаунт</TableHead>
                <TableHead>Состояние</TableHead>
                <TableHead>Токен</TableHead>
                <TableHead>Проект</TableHead>
                <TableHead className="text-right">Почта</TableHead>
                <TableHead className="text-right">Пароль</TableHead>
                <TableHead className="text-right">Правка</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    Аккаунтов пока нет.
                  </TableCell>
                </TableRow>
              ) : null}
              {accounts.map((account) => {
                const spent = isSpent(account, clock);
                const tokenState = tokenStates?.get(account.id)?.state;
                return (
                  <TableRow key={account.id} className={spent ? 'bg-destructive/10' : ''}>
                    <TableCell>
                      <div className="font-medium leading-tight">{account.title || '—'}</div>
                      <div className="font-mono text-xs text-muted-foreground">{account.email}</div>
                    </TableCell>
                    <TableCell>
                      {spent ? (
                        <>
                          <div className="text-destructive">Активирован</div>
                          <div className="text-xs text-muted-foreground">
                            <MinimaxCountdown
                              availableAt={account.availableAt}
                              remainingMs={account.remainingMs}
                              now={now}
                            />
                          </div>
                        </>
                      ) : (
                        <div className="text-emerald-600">Свободен</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">
                        {tokenState ? TOKEN_STATE_LABEL[tokenState] : '—'}
                      </div>
                      {tokenState === 'none' && onGetToken ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-1"
                          title="Получить токен этого аккаунта"
                          onClick={() => onGetToken(account.id)}
                        >
                          <KeyRound className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">{account.projectName ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        title="Скопировать почту (аккаунт не гаснет)"
                        onClick={() => onCopy(account, 'email')}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        title="Скопировать пароль (аккаунт не гаснет)"
                        onClick={() => onCopy(account, 'password')}
                      >
                        <KeyRound className="h-4 w-4" />
                      </Button>
                    </TableCell>
                    <TableCell className="text-right">
                      {onEdit ? (
                        <Button variant="ghost" size="sm" onClick={() => onEdit(account)}>
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
                    </TableCell>
                    <TableCell className="text-right">
                      <ConfirmDialog
                        title="Удалить аккаунт?"
                        description={`«${account.title || account.email}» будет удалён вместе с историей активаций.`}
                        onConfirm={() => onDelete(account)}
                        trigger={
                          <Button variant="ghost" size="icon" aria-label="Удалить аккаунт">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        }
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
