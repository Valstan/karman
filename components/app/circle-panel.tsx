'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { Check, LogOut, Pencil, Plus, Trash2, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import {
  createCircleAction,
  deleteCircleAction,
  inviteToCircleAction,
  leaveCircleAction,
  removeFromCircleAction,
  renameCircleAction,
  respondToInviteAction,
} from '@/lib/actions/circle';
import type { CircleView } from '@/lib/services/circle';

/**
 * Круги человека: приглашения, ожидающие ответа, и круги, где он состоит.
 *
 * Согласие даёт ТОЛЬКО сам человек и только за себя — поэтому кнопки «Согласен»
 * и «Отказаться» есть лишь у своей строки, а владелец круга может пригласить и
 * исключить, но не «подтвердить за».
 */

const STATE_LABEL: Record<string, string> = {
  consented: 'участвует',
  invited: 'приглашён, не ответил',
  declined: 'отказался',
  left: 'вышел',
};

function CreateCircleDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<{ name: string }>({ defaultValues: { name: '' } });

  async function onSubmit(values: { name: string }) {
    const result = await createCircleAction(values);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Круг создан');
    setOpen(false);
    reset({ name: '' });
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset({ name: '' });
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4" /> Новый круг
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Новый круг</DialogTitle>
          <DialogDescription>
            Вы станете его владельцем и первым участником. Остальных пригласите по логину — и
            каждый решит сам, входить ли.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="circle-name">Название</Label>
            <Input id="circle-name" placeholder="Круг Совиных" required {...register('name')} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Создание…' : 'Создать'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({ circle }: { circle: CircleView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<{ name: string }>({ defaultValues: { name: circle.name } });

  async function onSubmit(values: { name: string }) {
    const result = await renameCircleAction({ circleId: circle.id, name: values.name });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Название изменено');
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset({ name: circle.name });
      }}
    >
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" title="Переименовать">
          <Pencil className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Переименовать круг</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor={`rename-${circle.id}`}>Название</Label>
            <Input id={`rename-${circle.id}`} required {...register('name')} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Сохранение…' : 'Сохранить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function InviteForm({ circleId }: { circleId: number }) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<{ username: string }>({ defaultValues: { username: '' } });

  async function onSubmit(values: { username: string }) {
    const result = await inviteToCircleAction({ circleId, username: values.username });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(`Приглашение отправлено: ${values.username}`);
    reset({ username: '' });
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-wrap items-end gap-2">
      <div className="grid gap-1">
        <Label htmlFor={`invite-${circleId}`} className="text-xs">
          Логин человека
        </Label>
        <Input
          id={`invite-${circleId}`}
          placeholder="ulyana"
          className="sm:w-56"
          {...register('username')}
        />
      </div>
      <Button type="submit" variant="outline" size="sm" disabled={isSubmitting}>
        <UserPlus className="mr-1 h-4 w-4" />
        {isSubmitting ? 'Отправка…' : 'Пригласить'}
      </Button>
    </form>
  );
}

export function CirclePanel({
  circles,
  currentUserId,
}: {
  circles: CircleView[];
  currentUserId: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function respond(circleId: number, accept: boolean) {
    setBusy(true);
    const result = await respondToInviteAction({ circleId, accept });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(accept ? 'Вы в круге' : 'Приглашение отклонено');
    router.refresh();
  }

  async function leave(circleId: number) {
    setBusy(true);
    const result = await leaveCircleAction({ circleId });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Вы вышли из круга');
    router.refresh();
  }

  async function removeMember(circleId: number, userId: number) {
    setBusy(true);
    const result = await removeFromCircleAction({ circleId, userId });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Участник исключён');
    router.refresh();
  }

  async function removeCircle(circleId: number) {
    setBusy(true);
    const result = await deleteCircleAction({ circleId });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Круг удалён');
    router.refresh();
  }

  const pending = circles.filter((c) => c.myState === 'invited');
  const rest = circles.filter((c) => c.myState !== 'invited');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-end">
        <CreateCircleDialog />
      </div>

      {pending.length > 0 && (
        <Card className="border-amber-300 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="text-base">Вас пригласили</CardTitle>
            <CardDescription>
              Согласившись, вы откроете участникам круга свою карточку и документы, а они —
              свои вам. Отказ ничего не открывает; передумать можно в любой момент.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {pending.map((circle) => (
              <div key={circle.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{circle.name}</span>
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy} onClick={() => respond(circle.id, true)}>
                    <Check className="mr-1 h-4 w-4" /> Согласен
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => respond(circle.id, false)}
                  >
                    <X className="mr-1 h-4 w-4" /> Отказаться
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {rest.length === 0 && pending.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Кругов пока нет. Создайте свой и пригласите родных по логину — или дождитесь
            приглашения.
          </CardContent>
        </Card>
      )}

      {rest.map((circle) => (
        <Card key={circle.id}>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  {circle.name}
                  {circle.isOwner && <Badge variant="secondary">вы владелец</Badge>}
                  {circle.myState === 'declined' && <Badge variant="outline">вы отказались</Badge>}
                  {circle.myState === 'left' && <Badge variant="outline">вы вышли</Badge>}
                </CardTitle>
                <CardDescription>
                  {circle.members.filter((m) => m.state === 'consented').length} участников с
                  согласием из {circle.members.length}
                </CardDescription>
              </div>
              <div className="flex items-center gap-1">
                {circle.isOwner && <RenameDialog circle={circle} />}
                {circle.myState === 'consented' && !circle.isOwner && (
                  <ConfirmDialog
                    title={`Выйти из «${circle.name}»?`}
                    description="Ваши данные перестанут быть видны участникам, а их — вам. Данные не удаляются."
                    confirmText="Выйти"
                    onConfirm={() => leave(circle.id)}
                    trigger={
                      <Button size="icon" variant="ghost" title="Выйти из круга" disabled={busy}>
                        <LogOut className="h-4 w-4" />
                      </Button>
                    }
                  />
                )}
                {circle.isOwner && (
                  <ConfirmDialog
                    title={`Удалить круг «${circle.name}»?`}
                    description="Круг исчезнет у всех участников. Карточки и документы людей не удаляются."
                    onConfirm={() => removeCircle(circle.id)}
                    trigger={
                      <Button size="icon" variant="ghost" title="Удалить круг" disabled={busy}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    }
                  />
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ul className="flex flex-col gap-2">
              {circle.members.map((member) => (
                <li
                  key={member.userId}
                  className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-0 last:pb-0"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{member.name}</span>
                    <span className="text-xs text-muted-foreground">{member.username}</span>
                    <Badge variant={member.state === 'consented' ? 'default' : 'secondary'}>
                      {STATE_LABEL[member.state]}
                    </Badge>
                    {member.userId === currentUserId && <Badge variant="outline">это вы</Badge>}
                  </span>
                  {circle.isOwner && member.userId !== currentUserId && member.state !== 'left' && (
                    <ConfirmDialog
                      title={`Исключить ${member.name}?`}
                      description="Человек перестанет видеть данные круга, а участники — его данные."
                      confirmText="Исключить"
                      onConfirm={() => removeMember(circle.id, member.userId)}
                      trigger={
                        <Button size="sm" variant="ghost" disabled={busy}>
                          Исключить
                        </Button>
                      }
                    />
                  )}
                </li>
              ))}
            </ul>

            {circle.isOwner && <InviteForm circleId={circle.id} />}

            {circle.myState === 'declined' && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
                <span>Вы отказались от участия. Передумали?</span>
                <Button size="sm" disabled={busy} onClick={() => respond(circle.id, true)}>
                  Войти в круг
                </Button>
              </div>
            )}
            {circle.myState === 'left' && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
                <span>Вы вышли из этого круга.</span>
                <Button size="sm" disabled={busy} onClick={() => respond(circle.id, true)}>
                  Вернуться
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
