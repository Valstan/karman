'use client';

import { useState } from 'react';
import { useForm, useWatch, Controller } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { Plus, Ban, KeyRound } from 'lucide-react';
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
import { createIdentityAction, revokeIdentityAction } from '@/lib/actions/passport';
import { formatDateTime } from '@/lib/format';
import type { PassportIdentityRow, PassportIssuerOption } from '@/lib/services/passport';

export type IdentityRoomOption = { id: number; name: string; slug: string };

type FormValues = {
  issuerId: string;
  label: string;
  identityValue: string;
  projectId: string;
  canWrite: boolean;
  note: string;
};

function AddIdentityDialog({
  issuers,
  rooms,
}: {
  issuers: PassportIssuerOption[];
  rooms: IdentityRoomOption[];
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
    defaultValues: {
      issuerId: issuers[0] ? String(issuers[0].id) : '',
      label: '',
      identityValue: '',
      projectId: '',
      canWrite: false,
      note: '',
    },
  });

  // useWatch, а не watch(): второй не мемоизируется и валит гейт lint'а.
  const issuerId = useWatch({ control, name: 'issuerId' });
  const chosenIssuer = issuers.find((i) => String(i.id) === issuerId);

  async function onSubmit(values: FormValues) {
    const result = await createIdentityAction(values);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Личность заведена');
    reset();
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button disabled={issuers.length === 0 || rooms.length === 0}>
          <Plus className="mr-1 h-4 w-4" /> Завести личность
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Новая личность в реестре</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>Издатель удостоверений</Label>
            <Controller
              control={control}
              name="issuerId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Выберите издателя" />
                  </SelectTrigger>
                  <SelectContent>
                    {issuers.map((i) => (
                      <SelectItem key={i.id} value={String(i.id)}>
                        {i.issuer}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="identity-label">Метка</Label>
            <Input id="identity-label" placeholder="Valstan/MyRepo" {...register('label')} />
            <p className="text-xs text-muted-foreground">
              Человекочитаемое имя: попадает в аудит и в этот список. На проверку входа не влияет —
              вход решает идентификатор ниже.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="identity-value">
              Идентификатор{chosenIssuer ? ` (claim ${chosenIssuer.identityClaim})` : ''}
            </Label>
            <Input id="identity-value" placeholder="1296082925" {...register('identityValue')} />
            <p className="text-xs text-muted-foreground">
              Неизменяемый номер, а не имя: переименование репозитория не создаёт дыру, а перехват
              освободившегося имени не даёт личности. Для GitHub —{' '}
              <code className="font-mono">gh api repos/&lt;владелец&gt;/&lt;репо&gt; --jq .id</code>.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Комната</Label>
            <Controller
              control={control}
              name="projectId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Выберите комнату" />
                  </SelectTrigger>
                  <SelectContent>
                    {rooms.map((r) => (
                      <SelectItem key={r.id} value={String(r.id)}>
                        {r.name} ({r.slug})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <p className="text-xs text-muted-foreground">
              Комната по имени репозитория не угадывается и сама не заводится — выбирается явно.
            </p>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4" {...register('canWrite')} />
            <span>
              Разрешить запись — проект сможет сохранять свои секреты в комнату, а не только читать.
              Нужно тем, кто зеркалит ключи из деплоя; читателю не нужно.
            </span>
          </label>

          <div className="flex flex-col gap-2">
            <Label htmlFor="identity-note">Основание</Label>
            <Input
              id="identity-note"
              placeholder="номер решения или причина"
              {...register('note')}
            />
          </div>

          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Заведение…' : 'Завести'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PassportIdentitiesPanel({
  identities,
  issuers,
  rooms,
  canManage,
}: {
  identities: PassportIdentityRow[];
  issuers: PassportIssuerOption[];
  rooms: IdentityRoomOption[];
  /**
   * Владелец vault. Право проверяется на сервере (`createIdentity`); здесь оно
   * только для того, чтобы не рисовать кнопку, которая всегда отвечает отказом.
   * «Не нарисовали кнопку» правом не является.
   */
  canManage: boolean;
}) {
  const router = useRouter();

  async function revoke(id: number) {
    const result = await revokeIdentityAction(id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    const killed = result.data?.killed ?? 0;
    toast.success(
      killed > 0
        ? `Личность отозвана, погашено сессий: ${killed}`
        : 'Личность отозвана; живых сессий у неё не было',
    );
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <KeyRound className="h-5 w-5" /> Машинные личности
        </h2>
        {canManage && <AddIdentityDialog issuers={issuers} rooms={rooms} />}
      </div>

      <p className="text-sm text-muted-foreground">
        Кто из чужих CI может войти в свою комнату по подписанному удостоверению. Строки этого
        реестра — единственное, что отличает «удостоверение проверено» от «доступ разрешён»:
        без строки любое, даже валидное, удостоверение получает отказ.
      </p>

      {!canManage && (
        <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
          Заводить личности может только владелец vault: номер репозитория уникален на весь
          vault, и регистрация чужого номера увела бы чужой CI в свою комнату. Отзыв личностей
          своих комнат доступен вам и здесь.
        </div>
      )}

      {canManage && issuers.length === 0 && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
          <b>Нет доверенных издателей удостоверений.</b> Пока их нет, заводить личность не на что:
          строка реестра ссылается на издателя.
        </div>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Метка</TableHead>
              <TableHead>Идентификатор</TableHead>
              <TableHead>Комната</TableHead>
              <TableHead>Права</TableHead>
              <TableHead>Живых сессий</TableHead>
              <TableHead>Последний вход</TableHead>
              <TableHead>Заведена</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead className="text-right">Действия</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {identities.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="h-20 text-center text-muted-foreground">
                  Личностей пока нет — ни один чужой CI войти не может.
                </TableCell>
              </TableRow>
            )}
            {identities.map((i) => (
              <TableRow key={i.id}>
                <TableCell className="font-medium">{i.label}</TableCell>
                <TableCell className="font-mono text-sm text-muted-foreground">
                  {i.identityValue}
                </TableCell>
                <TableCell className="font-mono text-sm">{i.projectSlug}</TableCell>
                <TableCell>
                  <Badge variant={i.canWrite ? 'default' : 'secondary'}>
                    {i.canWrite ? 'read-write' : 'read-only'}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {i.revokedAt ? '—' : i.liveSessions}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {i.lastSessionAt ? (
                    formatDateTime(i.lastSessionAt)
                  ) : (
                    // Личность заведена, но ни разу не входила — чаще всего это
                    // опечатка в идентификаторе: отказ уходит строкой без комнаты,
                    // и в аудите самой комнаты его не видно.
                    <Badge variant="outline" title="Проверьте идентификатор: отказ входа в комнате не виден">
                      Ни разу не входила
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatDateTime(i.createdAt)}
                </TableCell>
                <TableCell>
                  {i.revokedAt ? (
                    <Badge variant="secondary">Отозвана {formatDateTime(i.revokedAt)}</Badge>
                  ) : (
                    <Badge variant="default">Действует</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    {!i.revokedAt && (
                      <ConfirmDialog
                        title={`Отозвать личность «${i.label}»?`}
                        description={
                          i.liveSessions > 0
                            ? `Её CI потеряет вход в комнату «${i.projectSlug}». Прямо сейчас у неё живых сессий: ${i.liveSessions} — они гаснут вместе со строкой, той же транзакцией. Завести личность заново потом можно.`
                            : `Её CI потеряет вход в комнату «${i.projectSlug}». Живых сессий сейчас нет. Завести личность заново потом можно.`
                        }
                        confirmText="Отозвать"
                        onConfirm={() => revoke(i.id)}
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
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
