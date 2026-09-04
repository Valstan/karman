import { NextResponse } from 'next/server';
import {
  buildAuthorizeUrl,
  esaConfig,
  esaEndpoints,
  newAuthRequest,
} from '@/lib/auth/oidc';
import { setOidcStateCookie } from '@/lib/auth/session';
import { logAuthAudit } from '@/lib/services/twofactor';
import { esaRedirectUri } from '@/lib/auth/oidc-redirect';

// node:crypto для PKCE — Edge не подходит.
export const runtime = 'nodejs';

function clientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() ?? null;
  return req.headers.get('x-real-ip');
}

/**
 * Начало входа через ЕСА: генерируем state/nonce/PKCE, кладём их в подписанную
 * cookie и уводим браузер на форму провайдера.
 *
 * GET, а не POST, потому что это обычная ссылка-кнопка. CSRF здесь не страшен:
 * запрос ничего не меняет, а результат всё равно упирается в проверку `state`
 * на возврате — начатый кем-то чужим вход просто не сойдётся.
 */
export async function GET(req: Request) {
  const cfg = esaConfig();
  if (!cfg) {
    return NextResponse.redirect(new URL('/login?esa=off', req.url));
  }

  const redirectUri = esaRedirectUri();
  if (!redirectUri) {
    await logAuthAudit(null, null, 'esa_misconfigured', clientIp(req));
    return NextResponse.redirect(new URL('/login?esa=off', req.url));
  }

  let endpoints;
  try {
    endpoints = await esaEndpoints(cfg);
  } catch {
    // Провайдер недоступен — это не ошибка пользователя и не повод показывать
    // ему внутренности. Возвращаем на форму с понятным маркером.
    await logAuthAudit(null, null, 'esa_discovery_failed', clientIp(req));
    return NextResponse.redirect(new URL('/login?esa=unavailable', req.url));
  }

  // Этот путь — ВСЕГДА вход и никогда привязка. Режим подписывается вместе с
  // состоянием, поэтому дописать себе `link` снаружи нельзя: привязку выдаёт
  // только server action, знающий, КТО её начал (`lib/actions/esa-link.ts`).
  const authRequest = newAuthRequest();
  await setOidcStateCookie({ ...authRequest, mode: 'login' });

  return NextResponse.redirect(
    buildAuthorizeUrl(endpoints, cfg, authRequest, redirectUri, 'login'),
  );
}
