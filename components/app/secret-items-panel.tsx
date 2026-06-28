'use client';

import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { Plus, Pencil, Trash2, Eye, EyeOff, Copy } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ConfirmDialog } from './confirm-dialog';
import { upsertItemAction, deleteItemAction, revealItemAction } from '@/lib/actions/secrets';
import { formatDate } from '@/lib/format';
import type { SecretItemMeta } from '@/lib/services/secrets';

function SecretItemDialog({
  projectId,
  trigger,
  existingKey,
}: {
  projectId: number;
  trigger: ReactNode;
  existingKey?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const isEdit = Boolean(existingKey);
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<{ key: string; value: string }>({
    defaultValues: { key: existingKey ?? '', value: '' },
  });

  async function onSubmit(values: { key: string; value: string }) {
    const result = await upsertItemAction({ projectId, key: values.key, value: values.value });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(isEdit ? 'Секрет обновлён' : 'Секрет добавлен');
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset({ key: existingKey ?? '', value: '' });
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Изменить значение: ${existingKey}` : 'Новый секрет'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="key">Ключ</Label>
            <Input
              id="key"
              required
              readOnly={isEdit}
              placeholder="DATABASE_URL"
              className="font-mono"
              {...register('key')}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="value">Значение</Label>
            <Input id="value" required type="password" autoComplete="off" {...register('value')} />
            {isEdit && (
              <p className="text-xs text-muted-foreground">Будет записано новое значение.</p>
            )}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Сохранение…' : isEdit ? 'Сохранить' : 'Добавить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SecretItemsPanel({
  projectId,
  items,
}: {
  projectId: number;
  items: SecretItemMeta[];
}) {
  const router = useRouter();
  const [revealed, setRevealed] = useState<Record<number, string>>({});

  async function toggleReveal(id: number) {
    if (id in revealed) {
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    const result = await revealItemAction(id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setRevealed((prev) => ({ ...prev, [id]: result.data!.value }));
  }

  async function copy(id: number) {
    let value = revealed[id];
    if (value === undefined) {
      const result = await revealItemAction(id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      value = result.data!.value;
    }
    await navigator.clipboard.writeText(value);
    toast.success('Скопировано');
  }

  async function remove(id: number) {
    const result = await deleteItemAction(id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Секрет удалён');
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Секреты</h2>
        <SecretItemDialog
          projectId={projectId}
          trigger={
            <Button size="sm">
              <Plus className="mr-1 h-4 w-4" /> Секрет
            </Button>
          }
        />
      </div>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ключ</TableHead>
              <TableHead>Значение</TableHead>
              <TableHead>Изменён</TableHead>
              <TableHead className="text-right">Действия</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="h-20 text-center text-muted-foreground">
                  Секретов пока нет.
                </TableCell>
              </TableRow>
            )}
            {items.map((it) => (
              <TableRow key={it.id}>
                <TableCell className="font-mono text-sm font-medium">{it.key}</TableCell>
                <TableCell className="font-mono text-sm">
                  {it.id in revealed ? (
                    <span className="break-all">{revealed[it.id]}</span>
                  ) : (
                    <span className="text-muted-foreground">••••••••</span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{formatDate(it.updatedAt)}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      title={it.id in revealed ? 'Скрыть' : 'Показать'}
                      onClick={() => toggleReveal(it.id)}
                    >
                      {it.id in revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                    <Button size="icon" variant="ghost" title="Скопировать" onClick={() => copy(it.id)}>
                      <Copy className="h-4 w-4" />
                    </Button>
                    <SecretItemDialog
                      projectId={projectId}
                      existingKey={it.key}
                      trigger={
                        <Button size="icon" variant="ghost" title="Изменить значение">
                          <Pencil className="h-4 w-4" />
                        </Button>
                      }
                    />
                    <ConfirmDialog
                      title="Удалить секрет?"
                      description={`Ключ «${it.key}» будет удалён безвозвратно.`}
                      onConfirm={() => remove(it.id)}
                      trigger={
                        <Button size="icon" variant="ghost" title="Удалить">
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      }
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
