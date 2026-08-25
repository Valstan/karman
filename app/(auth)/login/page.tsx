import { cookies } from 'next/headers';
import { LoginForm } from '@/components/auth/login-form';
import { esaConfig } from '@/lib/auth/oidc';
import { esaRedirectUri } from '@/lib/auth/oidc-redirect';
import { TOTP_PENDING_COOKIE, verifyTotpPending } from '@/lib/auth/jwt';

/**
 * Страница входа — серверная: только она может ответить на два вопроса, которые
 * нельзя решать в браузере. Настроена ли ЕСА (это env сервера, и показывать
 * кнопку, за которой ничего нет, — худший вид неработающего входа) и ждёт ли
 * пользователь второго фактора (pending-cookie подписана и читается на сервере;
 * доверять этому решению клиенту нельзя).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const esaParam = params.esa;
  const esaNotice = typeof esaParam === 'string' ? esaParam : null;

  const cookieStore = await cookies();
  const totpPending = (await verifyTotpPending(cookieStore.get(TOTP_PENDING_COOKIE)?.value)) !== null;

  const esaEnabled = esaConfig() !== null && esaRedirectUri() !== null;

  return <LoginForm esaEnabled={esaEnabled} totpPending={totpPending} esaNotice={esaNotice} />;
}
