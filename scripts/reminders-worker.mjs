// KARMAN reminders worker (P0) — тонкое реле Telegram ↔ Next.
//
// Делает две вещи и НИЧЕГО больше (никаких импортов lib/ — только node built-ins
// и global fetch, поэтому файл едет в артефакт как есть, без сборки):
//   1) long-poll Telegram getUpdates → POST /api/telegram/ingest (Bearer);
//   2) по таймеру POST /api/reminders/dispatch (Bearer).
// Вся работа с БД/сервисами — внутри Next-роутов. Запускается systemd-сервисом
// karman-reminders.service из /home/valstan/karman/current. См. docs/telegram-reminders.md.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const SECRET = process.env.REMINDERS_INTERNAL_SECRET || '';
const PORT = process.env.PORT || '3000';
const BASE = process.env.APP_BASE_URL || `http://127.0.0.1:${PORT}`;
const DISPATCH_INTERVAL_MS = Number(process.env.REMINDERS_DISPATCH_INTERVAL_MS || 25000);
const POLL_TIMEOUT_S = 25;

function log(...args) {
  console.log(new Date().toISOString(), '[reminders-worker]', ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postInternal(path, body) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(30_000),
  });
}

function startDispatchLoop() {
  const tick = async () => {
    try {
      const res = await postInternal('/api/reminders/dispatch', {});
      if (!res.ok) log('dispatch HTTP', res.status);
    } catch (error) {
      log('dispatch error', String(error));
    }
  };
  setInterval(tick, DISPATCH_INTERVAL_MS);
  tick();
}

async function startPollLoop() {
  let offset = 0;
  for (;;) {
    try {
      const url = `https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=${POLL_TIMEOUT_S}&offset=${offset}`;
      const res = await fetch(url, { signal: AbortSignal.timeout((POLL_TIMEOUT_S + 10) * 1000) });
      if (res.status === 409) {
        log('getUpdates 409 (конфликт: webhook/другой поллер?) — пауза 30с');
        await sleep(30_000);
        continue;
      }
      if (!res.ok) {
        log('getUpdates HTTP', res.status, '— пауза 5с');
        await sleep(5_000);
        continue;
      }
      const data = await res.json();
      if (!data.ok) {
        log('getUpdates not ok:', data.description || '');
        await sleep(5_000);
        continue;
      }
      for (const update of data.result) {
        offset = Math.max(offset, update.update_id + 1);
        try {
          const r = await postInternal('/api/telegram/ingest', update);
          if (!r.ok) log('ingest HTTP', r.status, 'update', update.update_id);
        } catch (error) {
          // offset уже сдвинут: один потерянный апдейт некритичен, не зацикливаемся.
          log('ingest error', String(error));
        }
      }
    } catch (error) {
      log('poll loop error', String(error), '— пауза 5с');
      await sleep(5_000);
    }
  }
}

if (!TOKEN || !SECRET) {
  log('TELEGRAM_BOT_TOKEN / REMINDERS_INTERNAL_SECRET не заданы — простаиваю (настройте env).');
  setInterval(() => log('ожидаю настройки env...'), 10 * 60_000);
} else {
  log(`старт: base=${BASE}, dispatch каждые ${DISPATCH_INTERVAL_MS}ms, poll timeout ${POLL_TIMEOUT_S}s`);
  startDispatchLoop();
  startPollLoop();
}
