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
import { isSpent } from '@/lib/accounts/rotation';
import type { ActivateKind } from './minimax-activation';
import type { AccountListItem, ProjectListItem } from '@/lib/services/accounts';

/**
 * Полный список аккаунтов (кнопка «показать все аккаунты»).
 *
 * Основной список показывает только верхний слот и последние активированные —
 * «чтобы не мешать» (04.11). Здесь — всё: видно, кто активирован, кто свободен,
 * и можно правку или удаление любого.
 */
export function MinimaxAllAccountsDialog({
  open,
  onOpenChange,
  accounts,
  projects,
  now,
  onCopy,
  onEdit,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: AccountListItem[];
  projects: ProjectListItem[];
  now: number | null;
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
            Полный список: кто активирован, кто свободен. Здесь же — правка и удаление.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Аккаунт</TableHead>
                <TableHead>Состояние</TableHead>
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
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    Аккаунтов пока нет.
                  </TableCell>
                </TableRow>
              ) : null}
              {accounts.map((account) => {
                const spent = isSpent(account, clock);
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
