'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  activateAccountAction,
  createProjectAction,
  deleteAccountAction,
  deleteProjectAction,
  revealAccountPasswordAction,
} from '@/lib/actions/accounts';
import { AccountFormDialog } from './account-form-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { utcToMoscowLocal } from '@/lib/reminders/time';
import type { AccountListItem, ProjectListItem } from '@/lib/services/accounts';
import type { ProjectUsage } from '@/lib/accounts/rotation';

const NONE = '__none__';

/**
 * Мультиаккаунт (задача владельца 2026-11-03).
 *
 * Правило: КОПИРОВАНИЕ почты или пароля = активация. Аккаунт гаснет до завтра
 * (московские сутки) и уходит вниз списка; наверх всплывает следующий
 * свободный. Ночной задачи нет — доступность считается при чтении.
 *
 * Порядок в списке: сначала доступные (сверху — тот, что использовался давнее
 * всех или ещё ни разу), ниже — израсходованные сегодня.
 */
export function AccountsPanel({
  accounts,
  projects,
  usage,
  currentProjectId,
}: {
  accounts: AccountListItem[];
  projects: ProjectListItem[];
  usage: ProjectUsage[];
  /** Выбранный проект (из URL) — на него уходят токены следующей активации. */
  currentProjectId: number | null;
}) {
  const router = useRouter();
  // Токены на активацию — по строке аккаунта (вводятся владельцем).
  const [tokens, setTokens] = useState<Record<number, string>>({});
  const [newProject, setNewProject] = useState('');

  function chooseProject(value: string) {
    // Выбор проекта живёт в URL (как активная вкладка «Карты»): ссылку можно
    // прислать владельцу, и состояние переживает перезагрузку без localStorage
    // (в проекте localStorage не используется — состояние живёт на сервере).
    router.push(value === NONE ? '/accounts' : `/accounts?project=${value}`);
  }

  const currentProject = currentProjectId;

  async function activate(account: AccountListItem) {
    const raw = (tokens[account.id] ?? '').trim();
    const result = await activateAccountAction({
      id: account.id,
      projectId: currentProject,
      tokens: raw === '' ? undefined : Number(raw),
    });
    if (!result.ok) {
      toast.error(result.error);
      return false;
    }
    router.refresh();
    return true;
  }

  async function copyEmail(account: AccountListItem) {
    try {
      await navigator.clipboard.writeText(account.email);
    } catch {
      toast.error('Не удалось скопировать почту');
      return;
    }
    // Копирование = активация: аккаунт гаснет до завтра.
    await activate(account);
    toast.success('Почта скопирована — аккаунт погашен до завтра');
  }

  async function copyPassword(account: AccountListItem) {
    const result = await revealAccountPasswordAction(account.id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    try {
      await navigator.clipboard.writeText(result.data!.password);
    } catch {
      toast.error('Не удалось скопировать пароль');
      return;
    }
    await activate(account);
    toast.success('Пароль скопирован — аккаунт погашен до завтра');
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

  async function addProject() {
    const name = newProject.trim();
    if (!name) return;
    const result = await createProjectAction({ name });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setNewProject('');
    toast.success(`Проект «${name}» добавлен`);
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

  return (
    <div className="flex flex-col gap-6">
      {/* Проекты: справочник названий + «на какой проект сейчас тратим». */}
      <div className="rounded-md border p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-56 flex-col gap-1">
            <span className="text-sm font-medium">Проект для следующей активации</span>
            <Select value={currentProject === null ? NONE : String(currentProject)} onValueChange={chooseProject}>
              <SelectTrigger>
                <SelectValue placeholder="Без проекта" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Без проекта</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={String(project.id)}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex min-w-56 flex-col gap-1">
            <span className="text-sm font-medium">Новый проект</span>
            <div className="flex gap-2">
              <Input
                value={newProject}
                placeholder="Матрица РМЗ, Сабантуй, Казанская…"
                onChange={(e) => setNewProject(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addProject();
                }}
              />
              <Button onClick={addProject}>
                <Plus className="mr-1 h-4 w-4" /> Добавить
              </Button>
            </div>
          </div>
        </div>

        {projects.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
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
        ) : null}
      </div>

      {/* Список аккаунтов. */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Аккаунт</TableHead>
              <TableHead>Почта</TableHead>
              <TableHead>Последний раз</TableHead>
              <TableHead className="w-32">Токены</TableHead>
              <TableHead className="text-right">Действия</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  Аккаунтов пока нет — добавьте первый.
                </TableCell>
              </TableRow>
            ) : null}
            {accounts.map((account) => (
              <TableRow
                key={account.id}
                className={account.spentToday ? 'opacity-60' : undefined}
              >
                <TableCell className="font-medium">
                  {account.title || '—'}
                  {account.spentToday ? (
                    <Badge variant="secondary" className="ml-2">
                      сегодня израсходован
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="font-mono text-xs">{account.email}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {account.usedAt ? (
                    <>
                      {utcToMoscowLocal(account.usedAt).replace('T', ' ')}
                      {account.projectName ? ` · ${account.projectName}` : ''}
                      {account.lastTokens ? ` · ${account.lastTokens} токенов` : ''}
                    </>
                  ) : (
                    'не использовался'
                  )}
                </TableCell>
                <TableCell>
                  <Input
                    type="number"
                    min={0}
                    inputMode="numeric"
                    className="h-8 w-24"
                    placeholder="0"
                    value={tokens[account.id] ?? ''}
                    onChange={(e) =>
                      setTokens((prev) => ({ ...prev, [account.id]: e.target.value }))
                    }
                  />
                </TableCell>
                <TableCell className="space-x-1 text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    title="Скопировать почту (аккаунт погаснет до завтра)"
                    onClick={() => copyEmail(account)}
                  >
                    <Copy className="mr-1 h-4 w-4" /> Почта
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    title="Скопировать пароль (аккаунт погаснет до завтра)"
                    onClick={() => copyPassword(account)}
                  >
                    <KeyRound className="mr-1 h-4 w-4" /> Пароль
                  </Button>
                  <AccountFormDialog
                    account={account}
                    trigger={
                      <Button variant="ghost" size="sm">
                        Правка
                      </Button>
                    }
                  />
                  <ConfirmDialog
                    title="Удалить аккаунт?"
                    description={`«${account.title || account.email}» будет удалён вместе с историей активаций.`}
                    onConfirm={() => removeAccount(account)}
                    trigger={
                      <Button variant="ghost" size="icon" aria-label="Удалить аккаунт">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    }
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Статистика по проектам. */}
      <div className="rounded-md border">
        <div className="flex items-center justify-between p-4 pb-2">
          <h2 className="text-lg font-semibold">Расход по проектам</h2>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Проект</TableHead>
              <TableHead className="text-right">Активаций</TableHead>
              <TableHead className="text-right">Токенов</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {usage.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-muted-foreground">
                  Пока нет ни одной активации.
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
    </div>
  );
}
