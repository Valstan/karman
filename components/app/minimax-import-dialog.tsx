'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { importAccountsAction } from '@/lib/actions/accounts';

/**
 * Массовый импорт аккаунтов: список строк «почта|пароль|название».
 *
 * Название необязательно — по умолчанию берётся имя ящика (часть до «@»).
 * Пароли уходят по HTTPS и шифруются на сервере мастер-ключом; в репозиторий
 * (он публичный) они не попадают никогда.
 */
export function MinimaxImportDialog({ trigger }: { trigger: ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  async function onImport() {
    setBusy(true);
    const result = await importAccountsAction(text);
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    const { created, skipped, failed, errors } = result.data!;
    if (errors.length > 0) {
      toast.error(`Не разобрано строк: ${errors.length} — ${errors[0]}`);
    }
    if (failed.length > 0) {
      toast.error(`Не создано: ${failed.length} — ${failed[0]}`);
    }
    if (created > 0) {
      toast.success(`Добавлено аккаунтов: ${created}`);
    }
    if (skipped.length > 0 && created === 0) {
      toast.info(`Уже были в базе: ${skipped.length}`);
    }
    if (created > 0 || skipped.length > 0) {
      setText('');
      router.refresh();
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Импорт списка аккаунтов</DialogTitle>
          <DialogDescription>
            По одной строке на аккаунт: почта|пароль|название. Название можно не указывать —
            возьмётся имя ящика.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="minimax-import">Список аккаунтов</Label>
          <Textarea
            id="minimax-import"
            rows={10}
            value={text}
            placeholder={'valstan@valstan.ru|Nitro@1941\npdo@rmz43.ru|Nitro@1941'}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Уже существующие почты пропускаются — импорт можно повторять. Пароли шифруются на
            сервере и в репозиторий не попадают.
          </p>
        </div>
        <DialogFooter>
          <Button onClick={onImport} disabled={busy || text.trim().length === 0}>
            Импортировать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
