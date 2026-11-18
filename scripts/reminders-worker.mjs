// KARMAN reminders worker (P0) — тонкое реле Telegram ↔ Next.
//
// Делает три вещи и НИЧЕГО больше (никаких импортов lib/ — только node built-ins
// и global fetch, поэтому файл едет в артефакт как есть, без сборки):
//   1) long-poll Telegram getUpdates → POST /api/telegram/ingest (Bearer);
//   2) по таймеру POST /api/reminders/dispatch (Bearer);
//   3) по таймеру POST /api/internal/minimax/reconcile (Bearer) — сверка журнала
//      активаций с панелью: ошибочно погашенные аккаунты возвращаются в оборот,
//      а наши предсказания очков уточняются по панели (заказ владельца 17.11);
//   5) раз в сутки, в 05:00 МСК, POST /api/internal/minimax/daily-bonus (Bearer) —
//      ежесуточный забор бонусов по всем аккаунтам MiniMax (заказ владельца 18.11):
//      серия дней подряд не рвётся, а в базе видно, у кого сколько очков сегодня.
// Вся работа с БД/сервисами — внутри Next-роутов. Запускается systemd-сервисом
// karman-reminders.service из текущего релиза (симлинк current). См. docs/telegram-reminders.md.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const SECRET = process.env.REMINDERS_INTERNAL_SECRET || '';
const PORT = process.env.PORT || '3000';
const BASE = process.env.APP_BASE_URL || `http://127.0.0.1:${PORT}`;
// База Bot API: на проде (РФ, IP Telegram заблокированы RKN) указывает на relay
// вне блока (Cloudflare Worker и т.п.). По умолчанию — прямой api.telegram.org.
const TG_API = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
// Реле закрыто общим секретом (X-Relay-Secret); прямому Bot API заголовок не нужен.
const RELAY_SECRET = process.env.TELEGRAM_RELAY_SECRET || '';
const TG_HEADERS = RELAY_SECRET ? { 'x-relay-secret': RELAY_SECRET } : {};
const DISPATCH_INTERVAL_MS = Number(process.env.REMINDERS_DISPATCH_INTERVAL_MS || 25000);
// Автосверка панели MiniMax: раз в 15 минут (состояние панели живёт полчаса,
// Сверка журнала активаций с панелью MiniMax: раз в полчаса (заказ владельца 17.11).
// автосверка; сверка их сама освобождает и уточняет.
const RECONCILE_INTERVAL_MS = Number(process.env.MINIMAX_RECONCILE_INTERVAL_MS || 30 * 60_000);
// Ежесуточный забор бонусов MiniMax: час в МСК (по умолчанию 5 утра).
// 05:00 МСК выбран не «на глаз»: сутки MiniMax считаются по поясу запроса, а поясов
// у нас два — московский (владелец) и UTC (потребитель); их границы — 00:00 и 03:00
// МСК. Обход в 05:00 идёт ПОСЛЕ обеих, поэтому «сегодня» у обеих сторон совпадает.
const DAILY_BONUS_HOUR_MSK = Number(process.env.MINIMAX_DAILY_BONUS_HOUR_MSK || 5);
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

/**


/**
 * Сверка журнала активаций с панелью MiniMax (заказ владельца 17.11).
 *
 * Запись активации пишется в момент выдачи аккаунта, а очки потребитель забирает
 * позже — когда его рантайм реально стартует. Всё это время журнал считает аккаунт
 * израсходованным (17.11: 111 записей против 53 реально забранных по панели).
 *
 * Сверка освобождает ошибочно погашенные аккаунты и уточняет нашу статистику
 * предсказаний по панели. Вендора не дёргает — берёт ответы автосверки, поэтому
 * раз в полчаса обходится бесплатно.
 */
function startReconcileLoop() {
  const tick = async () => {
    try {
      const res = await postInternal('/api/internal/minimax/reconcile', {});
      if (!res.ok) log('reconcile HTTP', res.status);
    } catch (error) {
      log('reconcile error', String(error));
    }
  };
  setInterval(tick, RECONCILE_INTERVAL_MS);
  tick();
}

/**
 * Ежесуточный забор бонусов MiniMax (заказ владельца 18.11).
 *
 * Раз в сутки, в DAILY_BONUS_HOUR_MSK по Москве. Забор идемпотентен в сутки (вендор
 * отдаёт «уже получено»), поэтому лишний заход ничего не ломает — а вот ПРОПУСК захода
 * ломает: у аккаунта не сдвинется клетка, и серия дней подряд оборвётся.
 *
 * Поэтому на старте воркера: если нужный час уже прошёл, забор делаем сразу (иначе
 * после перезапуска воркера сутки пропустили бы), а если ещё нет — ждём расписания.
 */
function startDailyBonusLoop() {
  const tick = async () => {
    try {
      const res = await postInternal('/api/internal/minimax/daily-bonus', {});
      if (!res.ok) log('daily-bonus HTTP', res.status);
    } catch (error) {
      log('daily-bonus error', String(error));
    }
    setTimeout(startDailyBonusLoop, msUntilDailyBonus());
  };

  const delay = msUntilDailyBonus();
  if (delay <= 0) {
    // Час уже прошёл (воркер перезапустили после него) — забираем сразу.
    tick();
    return;
  }
  setTimeout(tick, delay);
}

/** Сколько миллисекунд до следующего DAILY_BONUS_HOUR_MSK по Москве (UTC+3). */
function msUntilDailyBonus() {
  const hourUtc = (DAILY_BONUS_HOUR_MSK - 3 + 24) % 24;
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(hourUtc, 0, 0, 0);
  if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - now.getTime();
}

async function startPollLoop() {
  let offset = 0;
  for (;;) {
    try {
      const url = `${TG_API}/bot${TOKEN}/getUpdates?timeout=${POLL_TIMEOUT_S}&offset=${offset}`;
      const res = await fetch(url, {
        headers: TG_HEADERS,
        signal: AbortSignal.timeout((POLL_TIMEOUT_S + 10) * 1000),
      });
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
  log(`старт: base=${BASE}, dispatch каждые ${DISPATCH_INTERVAL_MS}ms, сверка журнала каждые ${RECONCILE_INTERVAL_MS}ms, забор бонусов в ${DAILY_BONUS_HOUR_MSK}:00 МСК, poll timeout ${POLL_TIMEOUT_S}s`);
  startDispatchLoop();
  startReconcileLoop();
  startDailyBonusLoop();
  startPollLoop();
}
