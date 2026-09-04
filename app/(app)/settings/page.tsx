import { requireUser } from '@/lib/auth/current-user';
import { esaConfig } from '@/lib/auth/oidc';
import { readOidcConfirm } from '@/lib/auth/session';
import { getEsaIdentity } from '@/lib/services/esa-link';
import { hasUsablePassword } from '@/lib/auth/password';
import { db } from '@/lib/db/client';
import { authUser } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getLinkForUser } from '@/lib/services/telegram-link';
import { totpEnabled, unusedRecoveryCount } from '@/lib/services/twofactor';
import { listAccounts } from '@/lib/services/users';
import { telegramConfigured } from '@/lib/telegram/config';
import { EsaLinkPanel } from '@/components/app/esa-link-panel';
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

  const esa = esaConfig();
  const identity = esa ? await getEsaIdentity(user.id, esa.issuer) : null;
  // Предложенную привязку показываем только той учётке, которой она выписана.
  const confirm = await readOidcConfirm();
  const pending = confirm && confirm.uid === user.id ? confirm : null;
  // Отвязка запрещена, пока ЕСА — единственный способ войти (см. unlinkEsaIdentity).
  const [row] = await db
    .select({ password: authUser.password })
    .from(authUser)
    .where(eq(authUser.id, user.id))
    .limit(1);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Настройки</h1>
      <EsaLinkPanel
        configured={Boolean(esa)}
        identity={identity ? { email: identity.email, createdAt: identity.createdAt } : null}
        pending={pending ? { email: pending.email, name: pending.name } : null}
        username={user.username}
        canUnlink={hasUsablePassword(row?.password ?? null)}
      />
      <TelegramLinkPanel
        configured={telegramConfigured()}
        linked={Boolean(link?.chatId)}
        username={link?.tgUsername ?? null}
      />
      <TwoFactorPanel enabled={enabled} recoveryLeft={recoveryLeft} />
      <PasswordPanel />
      {accounts && <UsersPanel accounts={accounts} currentUserId={user.id} />}
    </div>
  );
}
