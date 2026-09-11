// Cloudflare Worker `karman-tg` — реле к Telegram Bot API для прод-бокса в РФ,
// где api.telegram.org недоступен (см. docs/telegram-reminders.md).
//
// Деплоится НЕ из репозитория: исходник копируется в панель Cloudflare руками
// владельца (аккаунт его, wrangler в проекте нет). Этот файл — канонический текст
// и объект теста (karman-tg.test.ts); расхождение с тем, что крутится на
// Cloudflare, ловится приёмкой подсадным запросом, а не чтением панели.
//
// История: с 06.2026 по 09.2026 воркер был прозрачным прокси без единой
// проверки — кто угодно, узнав адрес, гонял через аккаунт владельца произвольные
// вызовы Bot API со своим токеном (мандат brain 2026-09-09). Теперь:
//   1. секрет в заголовке X-Relay-Secret обязан совпасть с переменной воркера
//      RELAY_SECRET; секрет не задан — реле ЗАКРЫТО (503), а не открыто;
//   2. только GET/POST;
//   3. только путь /bot<token>/<метод>, метод — из allowlist того, что KARMAN
//      реально зовёт; чужой токен с этим ничего не выигрывает, но и «любой
//      метод через чужой аккаунт» больше не доступен;
//   4. наружу уходит только content-type: заголовки звонящего (в т.ч. сам
//      X-Relay-Secret и cf-*) до Telegram не доезжают.

const UPSTREAM = 'https://api.telegram.org';
const ALLOWED_METHODS = new Set([
  'getUpdates',            // scripts/reminders-worker.mjs
  'sendMessage',           // lib/telegram/client.ts, scripts/health_watch.sh
  'answerCallbackQuery',   // lib/telegram/client.ts
  'editMessageReplyMarkup',// lib/telegram/client.ts
  'getMe',                 // приёмка/смоук
]);
const PATH_RE = /^\/bot\d+:[A-Za-z0-9_-]+\/([A-Za-z]+)$/;

function deny(status, text) {
  return new Response(text, { status, headers: { 'content-type': 'text/plain' } });
}

function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || provided.length !== expected.length) {
    return false;
  }
  // Постоянное время: без раннего выхода на первом несовпавшем байте.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

const relay = {
  async fetch(req, env) {
    const expected = env && typeof env.RELAY_SECRET === 'string' ? env.RELAY_SECRET : '';
    if (!expected) {
      return deny(503, 'relay is not configured');
    }
    if (!secretMatches(req.headers.get('x-relay-secret'), expected)) {
      return deny(403, 'forbidden');
    }
    if (req.method !== 'POST' && req.method !== 'GET') {
      return deny(405, 'method not allowed');
    }
    const url = new URL(req.url);
    const m = PATH_RE.exec(url.pathname);
    if (!m || !ALLOWED_METHODS.has(m[1])) {
      return deny(404, 'not found');
    }
    const headers = {};
    const ct = req.headers.get('content-type');
    if (ct) {
      headers['content-type'] = ct;
    }
    return fetch(UPSTREAM + url.pathname + url.search, {
      method: req.method,
      headers,
      body: req.method === 'POST' ? req.body : undefined,
    });
  },
};

export default relay;
