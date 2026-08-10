'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { Ban, Copy, Timer } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmDialog } from './confirm-dialog';
import { createBootstrapAction, revokeBootstrapAction } from '@/lib/actions/secrets';
import { formatDate } from '@/lib/format';
import type { BootstrapMeta } from '@/lib/services/bootstrap';

type FormValues = { ttlMinutes: number; canWrite: boolean; note: string };

function CreateBootstrapDialog({ projectId }: { projectId: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [issued, setIssued] = useState<{ code: string; expiresAt: string } | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<FormValues>({ defaultValues: { ttlMinutes: 30, canWrite: false, note: '' } });

  function close() {
    setOpen(false);
    setIssued(null);
    reset({ ttlMinutes: 30, canWrite: false, note: '' });
    router.refresh();
  }

  async function onSubmit(values: FormValues) {
    const result = await createBootstrapAction({ projectId, ...values });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setIssued({ code: result.data!.code, expiresAt: result.data!.expiresAt });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Timer className="mr-1 h-4 w-4" /> Времянка
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{issued ? 'Времянка выпущена' : 'Одноразовый код доступа'}</DialogTitle>
        </DialogHeader>
        {issued ? (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              Этот код <b>можно передать в чат или продиктовать</b>: он одноразовый, гаснет в момент
              обмена и действует до {formatDate(issued.expiresAt)}. Настоящий токен по нему проект
              получит сам — и токен нигде не прозвучит.
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={issued.code} className="font-mono text-xs" />
              <Button
                size="icon"
                variant="outline"
                title="Скопировать"
                onClick={async () => {
                  await navigator.clipboard.writeText(issued.code);
                  toast.success('Скопировано');
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Проект меняет код на токен так:
            </p>
            <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs">
              curl -X POST -H &quot;Authorization: Bearer {issued.code.slice(0, 12)}…&quot;
              https://&lt;ваш-хост&gt;/api/secrets/claim
            </pre>
            <DialogFooter>
              <Button onClick={close}>Готово</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="bootstrap-ttl">Срок жизни, минут</Label>
              <Input
                id="bootstrap-ttl"
                type="number"
                min={5}
                max={1440}
                {...register('ttlMinutes', { valueAsNumber: true })}
              />
              <p className="text-xs text-muted-foreground">
                5–1440. Чем короче, тем меньше окно, в котором код что-то значит.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bootstrap-note">Кому выдаётся (в аудит)</Label>
              <Input id="bootstrap-note" maxLength={500} placeholder="сессия MatricaRMZ, D-024" {...register('note')} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" {...register('canWrite')} />
              Выданный токен сможет писать (read-write)
            </label>
            <DialogFooter>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Выпуск…' : 'Выпустить'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function SecretBootstrapPanel({
  projectId,
  bootstraps,
}: {
  projectId: number;
  bootstraps: BootstrapMeta[];
}) {
  const router = useRouter();

  async function revoke(id: number) {
    const result = await revokeBootstrapAction(id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Времянка погашена');
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Времянки (одноразовый вход)</h2>
        <CreateBootstrapDialog projectId={projectId} />
      </div>

      <p className="text-sm text-muted-foreground">
        Времянка — код, который не жалко произнести: он живёт минуты, меняется на токен ровно
        один раз и после этого мёртв. Нужна, когда у проекта ещё нет токена, а комната уже
        наполнена (самообслуживание такую комнату не открывает). У проекта с CI лучший путь —
        паспорт, там не звучит вообще ничего.
      </p>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Код</TableHead>
              <TableHead>Даёт</TableHead>
              <TableHead>Действует до</TableHead>
              <TableHead>Состояние</TableHead>
              <TableHead className="text-right">Действия</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bootstraps.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                  Времянок не выпускалось.
                </TableCell>
              </TableRow>
            )}
            {bootstraps.map((b) => (
              <TableRow key={b.id}>
                <TableCell className="font-mono text-sm text-muted-foreground">{b.codePrefix}…</TableCell>
                <TableCell>
                  <Badge variant={b.canWrite ? 'default' : 'secondary'}>
                    {b.canWrite ? 'read-write' : 'read-only'}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{formatDate(b.expiresAt)}</TableCell>
                <TableCell>
                  {b.usedAt ? (
                    <Badge variant="secondary">Обменяна {formatDate(b.usedAt)}</Badge>
                  ) : b.revokedAt ? (
                    <Badge variant="secondary">Погашена</Badge>
                  ) : b.active ? (
                    <Badge variant="default">Ждёт обмена</Badge>
                  ) : (
                    <Badge variant="secondary">Истекла</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    {b.active && (
                      <ConfirmDialog
                        title="Погасить времянку?"
                        description="Код перестанет работать немедленно. Уже выданные по нему токены не затрагиваются."
                        confirmText="Погасить"
                        onConfirm={() => revoke(b.id)}
                        trigger={
                          <Button size="icon" variant="ghost" title="Погасить">
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
