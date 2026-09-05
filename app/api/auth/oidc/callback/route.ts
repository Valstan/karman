import { NextResponse } from 'next/server';
import { esaConfig, esaEndpoints, exchangeAndVerify } from '@/lib/auth/oidc';
import { appUrl, esaRedirectUri } from '@/lib/auth/oidc-redirect';
import {
  clearOidcStateCookie,
  readOidcState,
  readSessionPayload,
  setOidcConfirmCookie,
  setSessionCookie,
  setTotpPendingCookie,
} from '@/lib/auth/session';
import { resolveOidcLogin } from '@/lib/services/oidc-login';
import { logAuthAudit, totpEnabled } from '@/lib/services/twofactor';

export const runtime = 'nodejs';

function clientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() ?? null;
  return req.headers.get('x-real-ip');
}

/** Отказ всегда выглядит одинаково для пользователя; причина живёт в аудите. */
function deny(req: Request, marker: string) {
  return NextResponse.redirect(appUrl(`/login?esa=${marker}`, req));
}

/**
 * Возврат из ЕСА: сверяем state, меняем код на удостоверение, разрешаем личность
 * в пользователя и выдаём сессию — либо отправляем на второй фактор.
 *
 * **Второй фактор спрашивается и после ЕСА** (требование владельца). Это не
 * ритуал: привязка к существующему аккаунту делается по подтверждённой почте,
 * а значит тот, кто владеет почтой у провайдера, дошёл бы до чужой учётки.
 * TOTP — ровно то, что этого не даёт, и поэтому он здесь обязателен для всех,
 * у кого включён.
 */
export async function GET(req: Request) {
  const ip = clientIp(req);
  const url = new URL(req.url);

  const cfg = esaConfig();
  const redirectUri = esaRedirectUri();
  if (!cfg || !redirectUri) {
    await logAuthAudit(null, null, 'esa_misconfigured', ip);
    return deny(req, 'off');
  }

  // Провайдер вернул ошибку (пользователь отказал в доступе и т.п.).
  const providerError = url.searchParams.get('error');
  if (providerError) {
    // В аудит — код провайдера, не описание: описание он формирует сам,
    // и складывать чужой текст в наш лог незачем.
    await logAuthAudit(null, null, `esa_provider_error:${providerError.slice(0, 20)}`, ip);
    return deny(req, 'denied');
  }

  const saved = await readOidcState();
  // Куку гасим сразу и в любом случае: она одноразовая по замыслу, и её
  // переживание после первой попытки обмена — это возможность повторить обмен.
  await clearOidcStateCookie();

  if (!saved) {
    await logAuthAudit(null, null, 'esa_state_missing', ip);
    return deny(req, 'expired');
  }

  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || state !== saved.state) {
    await logAuthAudit(null, null, 'esa_state_mismatch', ip);
    return deny(req, 'bad_state');
  }
  if (!code) {
    await logAuthAudit(null, null, 'esa_code_missing', ip);
    return deny(req, 'bad_state');
  }

  let endpoints;
  try {
    endpoints = await esaEndpoints(cfg);
  } catch {
    await logAuthAudit(null, null, 'esa_discovery_failed', ip);
    return deny(req, 'unavailable');
  }

  const verified = await exchangeAndVerify(
    cfg,
    endpoints,
    code,
    saved.codeVerifier,
    redirectUri,
    saved.nonce,
  );
  if (!verified.ok) {
    await logAuthAudit(null, null, `esa_verify_fail:${verified.reason}`, ip);
    return deny(req, 'verify_failed');
  }

  // --- Привязка к существующему аккаунту -------------------------------------
  //
  // Ветка режима стоит ДО разрешения личности: у привязки нет ничего общего с
  // входом, кроме дороги через провайдера. Путь входа (`mode: 'login'`) сюда не
  // попадает никогда — режим подписан в состоянии, дописать его снаружи нельзя.
  if (saved.mode === 'link') {
    await logAuthAudit(null, null, `esa_userinfo:${verified.userinfo}`, ip);

    // Сессия обязана быть ЖИВОЙ и ТОЙ ЖЕ. За время похода в ЕСА человек мог
    // выйти, войти другим или открыть вторую вкладку — привязка «к текущему
    // аккаунту» в этих случаях означала бы привязку неизвестно к чему.
    const session = await readSessionPayload();
    if (!session || session.uid !== saved.uid) {
      await logAuthAudit(saved.uid ?? null, null, 'esa_link_fail:session_changed', ip);
      return NextResponse.redirect(appUrl('/settings?esa=link_session', req));
    }

    // Второй фактор: привязка добавляет учётке НОВЫЙ путь входа, то есть меняет
    // её безопасность. Тот же гейт, что у раздела секретов.
    if ((await totpEnabled(session.uid)) && !session.mfa) {
      await logAuthAudit(session.uid, null, 'esa_link_fail:mfa_required', ip);
      return NextResponse.redirect(appUrl('/settings?esa=link_mfa', req));
    }

    // Не привязываем здесь. Кладём проверенный результат в короткоживущую
    // подписанную cookie и показываем человеку, ЧЬЯ личность вернулась.
    // Обоснование — у `signOidcConfirm`: `prompt=login` мы просим, но исполнит
    // ли его провайдер, мы не контролируем, а цена ошибки — чужой ключ от
    // своей двери. Глазами человека это видно, кодом — нет.
    await setOidcConfirmCookie({
      uid: session.uid,
      issuer: cfg.issuer,
      subject: verified.claims.subject,
      email: verified.claims.email,
      name: verified.claims.name,
    });
    await logAuthAudit(session.uid, null, 'esa_link_confirm', ip);
    return NextResponse.redirect(appUrl('/settings?esa=confirm', req));
  }

  // Исход userinfo пишется ДО разрешения личности: самый интересный для разбора
  // случай — `not_invited`, и именно в нём диагностика бы потерялась. Владелец
  // получил три таких отказа с пустой почтой, не имея ни одной подсказки почему;
  // теперь ответ — один SELECT по auth_audit. Длина: префикс 13 символов плюс
  // самый длинный исход (16) при varchar(40) у auth_audit.action.
  await logAuthAudit(null, null, `esa_userinfo:${verified.userinfo}`, ip);

  const resolved = await resolveOidcLogin(cfg.issuer, verified.claims);
  if (!resolved.ok) {
    // Колонка username в аудите — varchar(150), а почта бывает длиннее:
    // обрезаем здесь, иначе запись аудита упала бы вместе с обработкой отказа.
    await logAuthAudit(
      null,
      verified.claims.email?.slice(0, 150) ?? null,
      `esa_resolve_fail:${resolved.reason}`,
      ip,
    );
    // Причина показывается человеку дословно: «не приглашён» и «несколько
    // учёток на одну почту» лечатся по-разному, и общая формулировка отправила
    // бы приглашённого родственника искать несуществующую вторую учётку.
    const DENY_MARKER = {
      user_inactive: 'inactive',
      ambiguous_email: 'ambiguous',
      not_invited: 'not_invited',
      // Связь была и её отвязали: предлагать «попросите пригласить» неверно —
      // человек уже приглашён, он сам её убрал и может привязать заново кнопкой.
      unlinked: 'unlinked',
    } as const;
    return deny(req, DENY_MARKER[resolved.reason]);
  }

  const { userId, username, outcome } = resolved.login;

  if (await totpEnabled(userId)) {
    await setTotpPendingCookie(userId);
    await logAuthAudit(userId, username, `esa_ok_totp_pending:${outcome}`, ip);
    // Форма входа сама покажет шаг кода, увидев pending-cookie.
    return NextResponse.redirect(appUrl('/login?esa=totp', req));
  }

  // Второго фактора у пользователя нет — сессия выдаётся без отметки mfa.
  // Заведённый этим входом пользователь при этом не видит ничего чужого: весь
  // доступ к данным фильтруется по владельцу (`lib/auth/rbac.ts`), поэтому
  // и список кредитов, и список комнат vault у него пустые.
  await setSessionCookie(userId);
  await logAuthAudit(userId, username, `esa_ok:${outcome}`, ip);
  return NextResponse.redirect(appUrl('/', req));
}
