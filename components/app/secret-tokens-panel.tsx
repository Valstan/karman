'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { Plus, Ban, Copy } from 'lucide-react';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ConfirmDialog } from './confirm-dialog';
import { createTokenAction, revokeTokenAction } from '@/lib/actions/secrets';
import { formatDate } from '@/lib/format';
import type { SecretTokenMeta } from '@/lib/services/secrets';

function CreateTokenDialog({ projectId }: { projectId: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<{ name: string }>({ defaultValues: { name: '' } });

  function close() {
    setOpen(false);
    setCreatedToken(null);
    reset({ name: '' });
    router.refresh();
  }

  async function onSubmit(values: { name: string }) {
    const result = await createTokenAction({ projectId, name: values.name });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setCreatedToken(result.data!.token);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="mr-1 h-4 w-4" /> Токен
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{createdToken ? 'Токен создан' : 'Новый токен доступа'}</DialogTitle>
        </DialogHeader>
        {createdToken ? (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              Скопируйте токен сейчас — он показывается <b>один раз</b> и больше не хранится в открытом виде.
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={createdToken} className="font-mono text-xs" />
              <Button
                size="icon"
                variant="outline"
                title="Скопировать"
                onClick={async () => {
                  await navigator.clipboard.writeText(createdToken);
                  toast.success('Скопировано');
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={close}>Готово</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="token-name">Название</Label>
              <Input id="token-name" required maxLength={200} placeholder="ci / prod-server" {...register('name')} />
              <p className="text-xs text-muted-foreground">Метка, чтобы отличать токены в списке.</p>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Создание…' : 'Создать'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function SecretTokensPanel({
  projectId,
  tokens,
}: {
  projectId: number;
  tokens: SecretTokenMeta[];
}) {
  const router = useRouter();

  async function revoke(id: number) {
    const result = await revokeTokenAction(id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Токен отозван');
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Токены доступа</h2>
        <CreateTokenDialog projectId={projectId} />
      </div>

      <p className="text-sm text-muted-foreground">
        Проект получает свои секреты так:
      </p>
      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs">
        curl -H &quot;Authorization: Bearer skm_…&quot; https://&lt;ваш-хост&gt;/api/secrets
      </pre>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Название</TableHead>
              <TableHead>Префикс</TableHead>
              <TableHead>Последнее использование</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead className="text-right">Действия</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                  Токенов пока нет.
                </TableCell>
              </TableRow>
            )}
            {tokens.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">{t.name}</TableCell>
                <TableCell className="font-mono text-sm text-muted-foreground">{t.tokenPrefix}…</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {t.lastUsedAt ? formatDate(t.lastUsedAt) : '—'}
                </TableCell>
                <TableCell>
                  {t.revokedAt ? (
                    <Badge variant="secondary">Отозван</Badge>
                  ) : (
                    <Badge variant="default">Активен</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    {!t.revokedAt && (
                      <ConfirmDialog
                        title="Отозвать токен?"
                        description="Проекты с этим токеном потеряют доступ. Действие необратимо."
                        confirmText="Отозвать"
                        onConfirm={() => revoke(t.id)}
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
