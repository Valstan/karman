import { requireUser } from '@/lib/auth/current-user';
import { getLinkForUser } from '@/lib/services/telegram-link';
import { totpEnabled, unusedRecoveryCount } from '@/lib/services/twofactor';
import { listAccounts } from '@/lib/services/users';
import { telegramConfigured } from '@/lib/telegram/config';
import { TelegramLinkPanel } from '@/components/app/telegram-link-panel';
import { TwoFactorPanel } from '@/components/app/two-factor-panel';
import { PasswordPanel } from '@/components/app/password-panel';
import { UsersPanel } from '@/components/app/users-panel';

export default async function SettingsPage() {
  const user = await requireUser();
  const link = await getLinkForUser(user.id);
  const enabled = await totpEnabled(user.id);
  const recoveryLeft = enabled ? await unusedRecoveryCount(user.id) : 0;
  const accounts = await listAccounts(user); // null — не superuser

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Настройки</h1>
      <TelegramLinkPanel
        configured={telegramConfigured()}
        linked={Boolean(link?.chatId)}
        username={link?.tgUsername ?? null}
      />
      <TwoFactorPanel enabled={enabled} recoveryLeft={recoveryLeft} />
      <PasswordPanel />
      {accounts && <UsersPanel accounts={accounts} />}
    </div>
  );
}
