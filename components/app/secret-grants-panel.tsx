'use client';

import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { Share2, Ban, ArrowRight, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ConfirmDialog } from './confirm-dialog';
import { createGrantAction, revokeGrantAction } from '@/lib/actions/secrets';
import { formatDate } from '@/lib/format';
import type { SecretGrants, SecretItemMeta } from '@/lib/services/secrets';

export type GrantRoomOption = { id: number; name: string; slug: string };

type FormValues = { sourceKey: string; targetProjectId: string; aliasKey: string; note: string };

function IssueGrantDialog({
  projectId,
  items,
  rooms,
}: {
  projectId: number;
  items: SecretItemMeta[];
  rooms: GrantRoomOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<FormValues>({
    defaultValues: { sourceKey: '', targetProjectId: '', aliasKey: '', note: '' },
  });

  async function onSubmit(values: FormValues) {
    const result = await createGrantAction({
      sourceProjectId: projectId,
      sourceKey: values.sourceKey,
      targetProjectId: values.targetProjectId,
      aliasKey: values.aliasKey,
      note: values.note,
    });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Доступ выдан');
    setOpen(false);
    reset({ sourceKey: '', targetProjectId: '', aliasKey: '', note: '' });
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset({ sourceKey: '', targetProjectId: '', aliasKey: '', note: '' });
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={rooms.length === 0}>
          <Share2 className="mr-1 h-4 w-4" /> Выдать доступ
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Выдать доступ к ключу</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="grant-source-key">Ключ этой комнаты</Label>
            <Input
              id="grant-source-key"
              required
              list="grant-source-keys"
              placeholder="GATEWAY_KEY_VMALMYZHE"
              className="font-mono"
              {...register('sourceKey')}
            />
            <datalist id="grant-source-keys">
              {items.map((it) => (
                <option key={it.id} value={it.key} />
              ))}
            </datalist>
            <p className="text-xs text-muted-foreground">
              Можно выдать доступ к ключу, которого ещё нет — сработает, как только он появится.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="grant-target">Кому</Label>
            <Controller
              control={control}
              name="targetProjectId"
              rules={{ required: true }}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="grant-target">
                    <SelectValue placeholder="Выберите комнату" />
                  </SelectTrigger>
                  <SelectContent>
                    {rooms.map((room) => (
                      <SelectItem key={room.id} value={String(room.id)}>
                        {room.name} ({room.slug})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="grant-alias">Имя у получателя</Label>
            <Input
              id="grant-alias"
              placeholder="то же имя"
              className="font-mono"
              {...register('aliasKey')}
            />
            <p className="text-xs text-muted-foreground">
              Под этим именем комната-получатель увидит значение в своём <code>GET /api/secrets</code>.
              Пусто — имя не меняется.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="grant-note">Основание</Label>
            <Input id="grant-note" maxLength={500} placeholder="мандат brain 2026-07-26" {...register('note')} />
            <p className="text-xs text-muted-foreground">Попадёт в аудит обеих комнат.</p>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Выдача…' : 'Выдать'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Выдача доступа между комнатами (мандат brain 2026-07-26): значение не копируется,
 * получатель читает ключ источника своим токеном под своим именем. Отзыв не требует
 * ротации секрета.
 */
export function SecretGrantsPanel({
  projectId,
  grants,
  items,
  rooms,
}: {
  projectId: number;
  grants: SecretGrants;
  items: SecretItemMeta[];
  rooms: GrantRoomOption[];
}) {
  const router = useRouter();
  const otherRooms = rooms.filter((r) => r.id !== projectId);

  async function revoke(id: number) {
    const result = await revokeGrantAction(id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Доступ отозван');
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Общие ключи</h2>
        <IssueGrantDialog projectId={projectId} items={items} rooms={otherRooms} />
      </div>

      <p className="text-sm text-muted-foreground">
        Один ключ, нужный двум проектам, не копируется между комнатами: источник остаётся один,
        получатель читает его своим токеном. Отзыв доступа не требует смены самого секрета.
      </p>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Направление</TableHead>
              <TableHead>Ключ</TableHead>
              <TableHead>Комната</TableHead>
              <TableHead>Основание</TableHead>
              <TableHead>Выдан</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead className="text-right">Действия</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.issued.length === 0 && grants.received.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-20 text-center text-muted-foreground">
                  Общих ключей нет.
                </TableCell>
              </TableRow>
            )}

            {grants.issued.map((g) => (
              <TableRow key={`out-${g.id}`}>
                <TableCell>
                  <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                    <ArrowRight className="h-4 w-4" /> выдан
                  </span>
                </TableCell>
                <TableCell className="font-mono text-sm">
                  {g.sourceKey}
                  {g.aliasKey !== g.sourceKey && (
                    <span className="text-muted-foreground"> → {g.aliasKey}</span>
                  )}
                </TableCell>
                <TableCell className="text-sm">{g.targetSlug}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{g.note ?? '—'}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{formatDate(g.createdAt)}</TableCell>
                <TableCell>
                  {g.revokedAt ? (
                    <Badge variant="secondary">Отозван</Badge>
                  ) : g.sourceExists ? (
                    <Badge variant="default">Действует</Badge>
                  ) : (
                    <Badge variant="secondary" title="Ключа с таким именем в этой комнате ещё нет">
                      Ждёт ключ
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    {!g.revokedAt && (
                      <ConfirmDialog
                        title="Отозвать доступ?"
                        description={`Комната «${g.targetSlug}» перестанет получать ${g.aliasKey}. Сам секрет менять не нужно.`}
                        confirmText="Отозвать"
                        onConfirm={() => revoke(g.id)}
                        trigger={
                          <Button size="icon" variant="ghost" title="Отозвать">
                            <Ban className="h-4 w-4 text-destructive" />
                          </Button>
                        }
                      />
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}

            {grants.received.map((g) => (
              <TableRow key={`in-${g.id}`}>
                <TableCell>
                  <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                    <ArrowLeft className="h-4 w-4" /> получен
                  </span>
                </TableCell>
                <TableCell className="font-mono text-sm">
                  {g.aliasKey}
                  {g.aliasKey !== g.sourceKey && (
                    <span className="text-muted-foreground"> ← {g.sourceKey}</span>
                  )}
                </TableCell>
                <TableCell className="text-sm">{g.sourceSlug}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{g.note ?? '—'}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{formatDate(g.createdAt)}</TableCell>
                <TableCell>
                  {g.revokedAt ? (
                    <Badge variant="secondary">Отозван</Badge>
                  ) : g.shadowed ? (
                    <Badge variant="secondary" title="У комнаты есть собственный ключ с этим именем — он выигрывает">
                      Заслонён своим
                    </Badge>
                  ) : (
                    <Badge variant="default">Действует</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  отзывает {g.sourceSlug}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
