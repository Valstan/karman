'use server';

import { buildAuthorizeUrl, esaConfig, esaEndpoints, newAuthRequest } from '@/lib/auth/oidc';
import { esaRedirectUri } from '@/lib/auth/oidc-redirect';
import {
  clearOidcConfirmCookie,
  readOidcConfirm,
  readSessionPayload,
  setOidcStateCookie,
} from '@/lib/auth/session';
import { linkEsaIdentity, unlinkEsaIdentity } from '@/lib/services/esa-link';
import { logAuthAudit, totpEnabled } from '@/lib/services/twofactor';
import { currentUserOrNull, revalidateAll, type ActionResult } from './_internal';

/**
 * Привязка аккаунта ВКонтакте (через ЕСА) к текущей учётной записи.
 *
 * Старт — server action, а НЕ GET-ссылка, и это не вкусовщина. Next сверяет у
 * server action заголовок Origin с Host и обрывает вызов до исполнения, поэтому
 * чужая страница не может начать привязку в браузере вошедшего человека.
 * GET-ссылку `/api/auth/oidc/start` начать со стороны можно — для входа это
 * безобидно (исход всё равно упрётся в state), но для привязки исход зависел бы
 * от того, чья сессия оказалась в браузере.
 */

/** Второй фактор — общий гейт всех операций с привязкой. */
async function requireLinkAccess(): Promise<
  { uid: number; error: null } | { uid: null; error: string }
> {
  const user = await currentUserOrNull();
  if (!user) return { uid: null, error: 'Требуется авторизация' };
  if (await totpEnabled(user.id)) {
    const payload = await readSessionPayload();
    if (!payload?.mfa) {
      return { uid: null, error: 'Войдите заново с кодом 2FA — привязка меняет способ входа' };
    }
  }
  return { uid: user.id, error: null };
}

/** Возвращает адрес формы ЕСА; переход делает клиент. */
export async function startEsaLinkAction(): Promise<ActionResult<{ url: string }>> {
  const guard = await requireLinkAccess();
  if (guard.uid === null) return { ok: false, error: guard.error };

  const cfg = esaConfig();
  const redirectUri = esaRedirectUri();
  if (!cfg || !redirectUri) return { ok: false, error: 'Вход через ЕСА не настроен на сервере' };

  let endpoints;
  try {
    endpoints = await esaEndpoints(cfg);
  } catch {
    return { ok: false, error: 'ЕСА сейчас недоступна — попробуйте позже' };
  }

  const authRequest = newAuthRequest();
  // uid подписывается ВНУТРИ состояния: на возврате он сверяется с живой
  // сессией, и привязка не состоится, если человек за это время вышел или
  // вошёл другим.
  await setOidcStateCookie({ ...authRequest, mode: 'link', uid: guard.uid });

  return {
    ok: true,
    data: { url: buildAuthorizeUrl(endpoints, cfg, authRequest, redirectUri, 'link') },
  };
}

/**
 * Подтверждение привязки — второй, ЯВНЫЙ шаг после возврата из ЕСА.
 *
 * Разделение на два шага не бюрократия: `prompt=login` мы просим, но исполнит
 * ли его провайдер, мы не контролируем. Не исполнит — вернётся личность, уже
 * сидящая в браузере, и человек молча привязал бы к себе чужую. Экран
 * подтверждения показывает, ЧЬЯ личность вернулась, и решение принимает
 * человек, а не совпадение обстоятельств.
 */
export async function confirmEsaLinkAction(): Promise<ActionResult<{ already: boolean }>> {
  const guard = await requireLinkAccess();
  if (guard.uid === null) return { ok: false, error: guard.error };

  const pending = await readOidcConfirm();
  if (!pending) {
    return { ok: false, error: 'Подтверждение истекло — начните привязку заново' };
  }
  if (pending.uid !== guard.uid) {
    // Cookie подтверждения выписана другой учётке — привязывать по ней нельзя.
    await clearOidcConfirmCookie();
    await logAuthAudit(guard.uid, null, 'esa_link_fail:session_changed', null);
    return { ok: false, error: 'Учётная запись сменилась — начните привязку заново' };
  }

  const result = await linkEsaIdentity(
    pending.uid,
    pending.issuer,
    pending.subject,
    pending.email,
  );
  await clearOidcConfirmCookie();

  if (!result.ok) {
    await logAuthAudit(guard.uid, null, `esa_link_fail:${result.reason}`, null);
    return { ok: false, error: result.error };
  }

  await logAuthAudit(guard.uid, null, 'esa_link_ok', null);
  revalidateAll();
  return { ok: true, data: { already: result.already } };
}

/** Отказаться от предложенной привязки, не привязывая. */
export async function dismissEsaLinkAction(): Promise<ActionResult> {
  await clearOidcConfirmCookie();
  revalidateAll();
  return { ok: true };
}

export async function unlinkEsaAction(): Promise<ActionResult> {
  const guard = await requireLinkAccess();
  if (guard.uid === null) return { ok: false, error: guard.error };

  const cfg = esaConfig();
  if (!cfg) return { ok: false, error: 'Вход через ЕСА не настроен на сервере' };

  const result = await unlinkEsaIdentity(guard.uid, cfg.issuer);
  if (!result.ok) {
    await logAuthAudit(guard.uid, null, `esa_unlink_fail:${result.reason}`, null);
    return { ok: false, error: result.error };
  }

  await logAuthAudit(guard.uid, null, 'esa_unlink_ok', null);
  revalidateAll();
  return { ok: true };
}
