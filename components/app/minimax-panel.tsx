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
import { MinimaxFormDialog } from './minimax-form-dialog';
import { MinimaxImportDialog } from './minimax-import-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { utcToMoscowLocal } from '@/lib/reminders/time';
import type { AccountListItem, ProjectListItem, ProjectUsageDay } from '@/lib/services/accounts';
import type { ProjectUsage } from '@/lib/accounts/rotation';

const NONE = '__none__';

/**
 * «Минимакс» — мультиаккаунт (задача владельца 2026-11-03).
 *
 * Правило: КОПИРОВАНИЕ почты или пароля = активация. Аккаунт гаснет до завтра
 * (московские сутки) и уходит вниз списка; наверх всплывает следующий
 * свободный. Ночной задачи нет — доступность считается при чтении.
 *
 * Порядок в списке: сначала доступные (сверху — тот, что использовался давнее
 * всех или ещё ни разу), ниже — израсходованные сегодня.
 *
 * Проект выбирается ПРЯМО В СТРОКЕ аккаунта (03.11): «выбираю проект и тут же
 * копирую почту и пароль — и этот аккаунт уходит в статистику как
 * активация этого проекта». По умолчанию в строке стоит проект последней
 * активации этого аккаунта — чтобы не выбирать его заново каждый день.
 */
export function MinimaxPanel({
  accounts,
  projects,
  usage,
  usageByDay,
}: {
  accounts: AccountListItem[];
  projects: ProjectListItem[];
  usage: ProjectUsage[];
  usageByDay: ProjectUsageDay[];
}) {
  const router = useRouter();
  // Токены на активацию — по строке аккаунта (вводятся владельцем).
  const [tokens, setTokens] = useState<Record<number, string>>({});
  // Проект на активацию — по строке аккаунта.
  const [rowProject, setRowProject] = useState<Record<number, string>>({});
  const [newProject, setNewProject] = useState('');

  function projectOf(account: AccountListItem): string {
    return rowProject[account.id] ?? (account.projectId === null ? NONE : String(account.projectId));
  }

  async function activate(account: AccountListItem) {
    const raw = (tokens[account.id] ?? '').trim();
    const selected = projectOf(account);
    const result = await activateAccountAction({
      id: account.id,
      projectId: selected === NONE ? null : Number(selected),
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
    // Копирование = активация: аккаунт гаснет до завтра, активация падает в
    // статистику выбранного в этой строке проекта.
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
      {/* Статистика — ПЕРВОЙ блоком: владелец 03.11 не нашёл её под списком
          аккаунтов. «Активация» — точное имя действия (копирование = активация),
          «погашен» — состояние аккаунта на сегодня. */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-md border">
          <div className="p-4 pb-2">
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
        </div>

        <div className="rounded-md border">
          <div className="p-4 pb-2">
            <h2 className="text-lg font-semibold">Активации по дням</h2>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>День</TableHead>
                <TableHead>Проект</TableHead>
                <TableHead className="text-right">Активаций</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usageByDay.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    Пока ни одной активации.
                  </TableCell>
                </TableRow>
              ) : null}
              {usageByDay.map((row) => (
                <TableRow key={`${row.usedOn}-${row.projectId ?? 'none'}`}>
                  <TableCell>{row.usedOn}</TableCell>
                  <TableCell>{row.projectName ?? 'Без проекта'}</TableCell>
                  <TableCell className="text-right">{row.activations}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Проекты: справочник названий. */}
      <div className="rounded-md border p-4">
        <div className="flex flex-wrap items-end gap-3">
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
          <MinimaxImportDialog
            trigger={
              <Button variant="outline">
                <Plus className="mr-1 h-4 w-4" /> Импорт списка
              </Button>
            }
          />
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
              <TableHead className="w-48">Проект</TableHead>
              <TableHead>Последний раз</TableHead>
              <TableHead className="w-28">Токены</TableHead>
              <TableHead className="text-right">Действия</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  Аккаунтов пока нет — добавьте первый или импортируйте список.
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
                      погашен на сегодня
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="font-mono text-xs">{account.email}</TableCell>
                <TableCell>
                  <Select
                    value={projectOf(account)}
                    onValueChange={(value) =>
                      setRowProject((prev) => ({ ...prev, [account.id]: value }))
                    }
                  >
                    <SelectTrigger className="h-8">
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
                </TableCell>
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
                  <MinimaxFormDialog
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
    </div>
  );
}
