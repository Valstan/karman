import Link from 'next/link';
import { Plus } from 'lucide-react';
import { requireUser } from '@/lib/auth/current-user';
import { listReminders } from '@/lib/services/reminders';
import { getLinkForUser } from '@/lib/services/telegram-link';
import { telegramConfigured } from '@/lib/telegram/config';
import { Button } from '@/components/ui/button';
import { ReminderFormDialog } from '@/components/app/reminder-form-dialog';
import { RemindersTable } from '@/components/app/reminders-table';

export default async function RemindersPage() {
  const user = await requireUser();
  const [reminders, link] = await Promise.all([listReminders(user), getLinkForUser(user.id)]);
  const linked = Boolean(link?.chatId);
  const configured = telegramConfigured();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Напоминания</h1>
        <ReminderFormDialog
          trigger={
            <Button>
              <Plus className="mr-1 h-4 w-4" /> Новое
            </Button>
          }
        />
      </div>

      {!configured ? (
        <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          Telegram-бот не настроен на сервере — напоминания пока не доставляются.
        </p>
      ) : !linked ? (
        <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          Telegram не привязан — напоминания не дойдут.{' '}
          <Link href="/settings" className="font-medium text-primary underline">
            Привязать в настройках
          </Link>
          .
        </p>
      ) : null}

      <RemindersTable reminders={reminders} />
    </div>
  );
}
