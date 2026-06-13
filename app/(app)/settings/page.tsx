import { requireUser } from '@/lib/auth/current-user';
import { getLinkForUser } from '@/lib/services/telegram-link';
import { telegramConfigured } from '@/lib/telegram/config';
import { TelegramLinkPanel } from '@/components/app/telegram-link-panel';

export default async function SettingsPage() {
  const user = await requireUser();
  const link = await getLinkForUser(user.id);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Настройки</h1>
      <TelegramLinkPanel
        configured={telegramConfigured()}
        linked={Boolean(link?.chatId)}
        username={link?.tgUsername ?? null}
      />
    </div>
  );
}
