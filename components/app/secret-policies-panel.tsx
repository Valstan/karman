'use client';

import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { ShieldCheck, Ban } from 'lucide-react';
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
import { createPolicyAction, revokePolicyAction } from '@/lib/actions/secrets';
import { formatDateTime } from '@/lib/format';
import type { SecretPolicyListItem } from '@/lib/services/secrets';

type RoomOption = { id: number; name: string; slug: string };

type FormValues = { sourceProjectId: string; sourceKey: string; aliasKey: string; note: string };

function DeclarePolicyDialog({ projectId, rooms }: { projectId: number; rooms: RoomOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<FormValues>({
    defaultValues: { sourceProjectId: '', sourceKey: '', aliasKey: '', note: '' },
  });

  async function onSubmit(values: FormValues) {
    const result = await createPolicyAction({
      targetProjectId: projectId,
      sourceProjectId: values.sourceProjectId,
      sourceKey: values.sourceKey,
      aliasKey: values.aliasKey,
      note: values.note,
    });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Политика приёма объявлена — авто-приём включён');
    setOpen(false);
    reset({ sourceProjectId: '', sourceKey: '', aliasKey: '', note: '' });
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset({ sourceProjectId: '', sourceKey: '', aliasKey: '', note: '' });
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={rooms.length === 0}>
          <ShieldCheck className="mr-1 h-4 w-4" /> Объявить политику
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Политика приёма: авто-accept по allowlist</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="policy-source">Откуда принимать</Label>
            <Controller
              control={control}
              name="sourceProjectId"
              rules={{ required: true }}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="policy-source">
                    <SelectValue placeholder="Выберите комнату-источник" />
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
            <Label htmlFor="policy-key">Ключ источника</Label>
            <Input
              id="policy-key"
              required
              placeholder="HOTLINE_RELAY_SECRET"
              className="font-mono"
              {...register('sourceKey')}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="policy-alias">Принимать как</Label>
            <Input
              id="policy-alias"
              placeholder="то же имя"
              className="font-mono"
              {...register('aliasKey')}
            />
            <p className="text-xs text-muted-foreground">
              Имя приёма фиксирует политика: предложение источника с другим именем
              примется под этим. Пусто — имя не меняется.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="policy-note">Основание</Label>
            <Input id="policy-note" maxLength={500} placeholder="D-119" {...register('note')} />
            <p className="text-xs text-muted-foreground">Попадёт в аудит этой комнаты.</p>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Объявление…' : 'Объявить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Политики приёма (S2, D-119): комната объявляет allowlist один раз, дальше
 * предложения по тройке (получатель, источник, ключ) принимаются сами —
 * в выдачу попадает номер политики основанием. Отзыв одной строкой: будущие
 * предложения ждут ручного accept, уже принятые выдачи живут.
 */
export function SecretPoliciesPanel({
  projectId,
  policies,
  rooms,
}: {
  projectId: number;
  policies: SecretPolicyListItem[];
  rooms: RoomOption[];
}) {
  const router = useRouter();
  const otherRooms = rooms.filter((r) => r.id !== projectId);

  async function revoke(id: number) {
    const result = await revokePolicyAction(id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Политика отозвана — авто-приём выключен');
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Политики приёма</h2>
        <DeclarePolicyDialog projectId={projectId} rooms={otherRooms} />
      </div>

      <p className="text-sm text-muted-foreground">
        Согласие, данное один раз: «принимаю этот ключ от этой комнаты» — дальше предложение
        токеном источника принимается автоматически. Отзыв гасит будущие предложения,
        уже принятые выдачи остаются.
      </p>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Источник</TableHead>
              <TableHead>Ключ</TableHead>
              <TableHead>Принимать как</TableHead>
              <TableHead>Основание</TableHead>
              <TableHead>Объявлена</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead className="text-right">Действия</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {policies.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-20 text-center text-muted-foreground">
                  Политик приёма нет: предложения выдач ждут вашего ручного принятия.
                </TableCell>
              </TableRow>
            )}
            {policies.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="text-sm">{p.sourceSlug}</TableCell>
                <TableCell className="font-mono text-sm">{p.sourceKey}</TableCell>
                <TableCell className="font-mono text-sm">
                  {p.aliasKey}
                  {p.aliasKey !== p.sourceKey && (
                    <span className="text-muted-foreground"> ← {p.sourceKey}</span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{p.note ?? '—'}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{formatDateTime(p.createdAt)}</TableCell>
                <TableCell>
                  {p.revokedAt ? (
                    <Badge variant="secondary">Отозвана</Badge>
                  ) : (
                    <Badge variant="default" title="Предложения по этой тройке принимаются автоматически">
                      Авто-приём
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    {!p.revokedAt && (
                      <ConfirmDialog
                        title="Отозвать политику?"
                        description={`Предложения «${p.sourceKey} от комнаты «${p.sourceSlug}»» снова будут ждать ручного принятия. Уже принятые выдачи останутся.`}
                        confirmText="Отозвать"
                        onConfirm={() => revoke(p.id)}
                        trigger={
                          <Button size="icon" variant="ghost" title="Отозвать политику">
                            <Ban className="h-4 w-4 text-destructive" />
                          </Button>
                        }
                      />
                    )}
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
