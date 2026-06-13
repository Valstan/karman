'use client';

import { useRouter } from 'next/navigation';
import { Pencil, Trash2, Pause, Play } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ReminderFormDialog } from './reminder-form-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { deleteReminderAction, setReminderStatusAction } from '@/lib/actions/reminders';
import { utcToMoscowLocal } from '@/lib/reminders/time';
import type { ReminderListItem } from '@/lib/services/reminders';

function fmt(utcIso: string | null): string {
  if (!utcIso) return '—';
  const [date, time] = utcToMoscowLocal(utcIso).split('T');
  const [y, m, d] = date!.split('-');
  return `${d}.${m}.${y} ${time}`;
}

export function RemindersTable({ reminders }: { reminders: ReminderListItem[] }) {
  const router = useRouter();

  async function remove(id: number) {
    const result = await deleteReminderAction(id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Напоминание удалено');
    router.refresh();
  }

  async function toggle(id: number, next: 'active' | 'paused') {
    const result = await setReminderStatusAction(id, next);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(next === 'paused' ? 'Поставлено на паузу' : 'Возобновлено');
    router.refresh();
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Заголовок</TableHead>
            <TableHead>Когда</TableHead>
            <TableHead>Статус</TableHead>
            <TableHead className="text-right">Действия</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {reminders.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                Напоминаний пока нет.
              </TableCell>
            </TableRow>
          )}
          {reminders.map((r) => {
            const scheduled = r.status !== 'paused' && r.nextFireAt;
            const whenLabel = scheduled
              ? fmt(r.nextFireAt)
              : r.lastFiredAt
                ? `отправлено ${fmt(r.lastFiredAt)}`
                : '—';
            return (
              <TableRow key={r.id}>
                <TableCell className="font-medium">
                  {r.title}
                  {r.priority === 'high' && (
                    <Badge variant="destructive" className="ml-2 align-middle">
                      важное
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{whenLabel}</TableCell>
                <TableCell>
                  {r.status === 'paused' ? (
                    <Badge variant="secondary">на паузе</Badge>
                  ) : r.nextFireAt ? (
                    <Badge>запланировано</Badge>
                  ) : (
                    <Badge variant="outline">выполнено</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    {r.status !== 'paused' ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Пауза"
                        onClick={() => toggle(r.id, 'paused')}
                      >
                        <Pause className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Возобновить"
                        onClick={() => toggle(r.id, 'active')}
                      >
                        <Play className="h-4 w-4" />
                      </Button>
                    )}
                    <ReminderFormDialog
                      reminder={r}
                      trigger={
                        <Button size="icon" variant="ghost" title="Редактировать">
                          <Pencil className="h-4 w-4" />
                        </Button>
                      }
                    />
                    <ConfirmDialog
                      title="Удалить напоминание?"
                      description="Действие необратимо."
                      onConfirm={() => remove(r.id)}
                      trigger={
                        <Button size="icon" variant="ghost" title="Удалить">
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      }
                    />
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
