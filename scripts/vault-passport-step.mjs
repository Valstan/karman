#!/usr/bin/env node
/**
 * Паспортный шаг деплоя: OIDC-удостоверение прогона → токен своей комнаты
 * (ADR-0012 мозга, волна 0; мандат D-241 от 19.11).
 *
 * ЗАЧЕМ. Проект должен сам открывать себе доступы на проде КАРМАНА, без оператора:
 * подпись GitHub OIDC доказывает личность, личность привязана к комнате, комната
 * выпускает токен. Этот скрипт — тот самый шаг, который копируется в воркфлоу
 * потребителя (одна строка `permissions: id-token: write` + этот файл).
 *
 * ЧТО ДЕЛАЕТ.
 *   1. Берёт OIDC-удостоверение прогона у раннера (audience — наш, `karman-vault`).
 *   2. Обменивает его в `POST /api/secrets/session` на короткоживущий токен своей
 *      комнаты (право — из личности, не из тела запроса).
 *   3. По `--claim` — обменивает сессию на ПОСТОЯННЫЙ токен комнаты
 *      (`POST /api/secrets/claim`; поддержка обмена паспортом появится в волне 1 —
 *      до неё шаг честно падает с 401, и это видно, а не «почти готово»).
 *   4. Гасит сессию (DELETE), чтобы короткоживущий токен не жил зря.
 *
 * БЕЗОПАСНОСТЬ. Токен НИКОГДА не печатается: он пишется в файл (0600), в журнал
 * уходят только slug, canWrite и префикс. Ответ сервера с ошибкой печатается (там
 * нет секретов — «Личность не зарегистрирована»), но тело успешного ответа — нет.
 *
 * ИСПОЛЬЗОВАНИЕ (в шаге воркфлоу):
 *   - run: node scripts/vault-passport-step.mjs --base "$KARMAN_VAULT_URL" --out "$RUNNER_TEMP/room-token"
 *   env:
 *     KARMAN_VAULT_URL: ${{ vars.KARMAN_VAULT_URL }}
 *   permissions:
 *     id-token: write
 */

import { writeFileSync } from 'node:fs';

/** Куда ходим за удостоверением прогона. GitHub кладёт эти две переменные в env. */
export function oidcRequestUrl(env) {
  const base = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  if (!base) throw new Error('шаг требует `permissions: id-token: write` (нет ACTIONS_ID_TOKEN_REQUEST_URL)');
  const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!token) throw new Error('шаг требует `permissions: id-token: write` (нет ACTIONS_ID_TOKEN_REQUEST_TOKEN)');
  const url = new URL(base);
  url.searchParams.set('audience', env.KARMAN_VAULT_AUDIENCE || 'karman-vault');
  return { url: url.toString(), token };
}

/** Безопасная сводка по сессии: без самого токена. */
export function summarizeSession(session) {
  return {
    slug: session.slug ?? null,
    canWrite: session.canWrite === true,
    tokenPrefix: session.tokenPrefix ?? null,
    expiresAt: session.expiresAt ?? null,
  };
}

/** Читаемый текст ошибки: код + сообщение сервера (без секретов в ответе). */
export function describeFailure(status, body) {
  let message = '';
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      message = typeof parsed.error === 'string' ? parsed.error : '';
    } catch {
      message = '';
    }
  }
  return `HTTP ${status}${message ? `: ${message}` : ''}`;
}

/**
 * Основной проход шага. Всё внешнее внедряется — чтобы шаг был проверяем гейтом,
 * а не «работает, потому что работает».
 */
export async function runPassportStep(options) {
  const {
    base,
    env = process.env,
    fetchImpl = fetch,
    writeToken = writeFileSync,
    log = console.log,
    out = null,
    claim = false,
  } = options;

  const baseUrl = String(base || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('нужен --base (адрес КАРМАНА с /api/secrets)');

  const { url: oidcUrl, token: oidcToken } = oidcRequestUrl(env);

  // 1. Удостоверение прогона.
  const oidcRes = await fetchImpl(oidcUrl, {
    headers: { authorization: `Bearer ${oidcToken}`, accept: 'application/json' },
  });
  if (!oidcRes.ok) {
    throw new Error(`не удалось взять удостоверение прогона: HTTP ${oidcRes.status}`);
  }
  const assertion = (await oidcRes.json()).value ?? (await oidcRes.text());
  if (!assertion || typeof assertion !== 'string') {
    throw new Error('удостоверение прогона пустое');
  }

  // 2. Паспортная сессия своей комнаты.
  const sessionRes = await fetchImpl(`${baseUrl}/api/secrets/session`, {
    method: 'POST',
    headers: { authorization: `Bearer ${assertion}`, accept: 'application/json' },
  });
  const sessionBody = await sessionRes.text();
  if (!sessionRes.ok) {
    throw new Error(`паспорт не принят: ${describeFailure(sessionRes.status, sessionBody)}`);
  }
  const session = JSON.parse(sessionBody);
  const summary = summarizeSession(session);
  log(`паспорт: комната ${summary.slug}, право ${summary.canWrite ? 'rw' : 'ro'}, префикс ${summary.tokenPrefix ?? '-'}`);

  let token = session.token;
  let tokenKind = 'session';
  try {
    // 3. Обмен на постоянный токен (по --claim).
    if (claim) {
      const claimRes = await fetchImpl(`${baseUrl}/api/secrets/claim`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.token}`, accept: 'application/json' },
      });
      const claimBody = await claimRes.text();
      if (!claimRes.ok) {
        throw new Error(`обмен на постоянный токен не состоялся: ${describeFailure(claimRes.status, claimBody)}`);
      }
      const permanent = JSON.parse(claimBody);
      token = permanent.token;
      tokenKind = 'permanent';
      log(`постоянный токен: комната ${permanent.slug}, право ${permanent.canWrite ? 'rw' : 'ro'}, префикс ${permanent.tokenPrefix ?? '-'}`);
    }

    // 4. Токен — в файл, не в журнал.
    if (out) {
      writeToken(out, token, { encoding: 'utf8', mode: 0o600 });
      log(`токен (${tokenKind}) записан в ${out}`);
    }
    return { slug: summary.slug, canWrite: summary.canWrite, tokenKind, out };
  } finally {
    // 5. Сессию гасим всегда: короткоживущий токен не должен жить зря.
    try {
      await fetchImpl(`${baseUrl}/api/secrets/session`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${session.token}` },
      });
      log('сессия погашена');
    } catch (error) {
      log(`сессию погасить не удалось: ${String(error)}`);
    }
  }
}

// Запуск из командной строки.
if (process.argv[1] && process.argv[1].endsWith('vault-passport-step.mjs')) {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  runPassportStep({
    base: arg('--base') || process.env.KARMAN_VAULT_URL,
    out: arg('--out') || null,
    claim: args.includes('--claim'),
  }).catch((error) => {
    console.error(`vault-passport-step: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
