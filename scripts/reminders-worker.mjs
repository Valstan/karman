// KARMAN reminders worker (P0) — тонкое реле Telegram ↔ Next.
//
// Делает три вещи и НИЧЕГО больше (никаких импортов lib/ — только node built-ins
// и global fetch, поэтому файл едет в артефакт как есть, без сборки):
//   1) long-poll Telegram getUpdates → POST /api/telegram/ingest (Bearer);
//   2) по таймеру POST /api/reminders/dispatch (Bearer);
//   3) раз в сутки, в 05:00 МСК, POST /api/internal/minimax/daily-bonus (Bearer) —
//      ежесуточный забор бонусов по всем аккаунтам MiniMax (заказ владельца 18.11):
//      серия дней подряд не рвётся, а в базе видно, у кого сколько очков сегодня.
// Вся работа с БД/сервисами — внутри Next-роутов. Запускается systemd-сервисом
// karman-reminders.service из текущего релиза (симлинк current). См. docs/telegram-reminders.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
// автосверка его обновляет).
// Проверка ежесуточного забора: как часто смотрим, не нужен ли он (маркер ставит
// приложение по факту завершения обхода — если обход умер, маркера нет).
const DAILY_BONUS_CHECK_MS = Number(process.env.MINIMAX_DAILY_BONUS_CHECK_MS || 30 * 60_000);
// Ежесуточный забор бонусов MiniMax: час в МСК (по умолчанию 5 утра).
// 05:00 МСК выбран не «на глаз»: сутки MiniMax считаются по поясу запроса, а поясов
// у нас два — московский (владелец) и UTC (потребитель); их границы — 00:00 и 03:00
// МСК. Обход в 05:00 идёт ПОСЛЕ обеих, поэтому «сегодня» у обеих сторон совпадает.
const DAILY_BONUS_HOUR_MSK = Number(process.env.MINIMAX_DAILY_BONUS_HOUR_MSK || 5);
// Повтор забора, если он не удался (приложение ещё поднимается после деплоя, сеть
// моргнула). Раньше был один шанс: упал — жди до завтра, и сутки обхода не было.
const DAILY_BONUS_RETRY_MS = Number(process.env.MINIMAX_DAILY_BONUS_RETRY_MS || 5 * 60_000);
// Каталог состояния воркера: маркер «обход за московские сутки уже был». Живёт рядом
// с пользователем сервиса (valstan) и переживает деплой: без него каждый рестарт
// воркера дёргал бы вендора заново (забор по 136 аккаунтам), а владелец просил
// держать нагрузку на MiniMax разумной.
const STATE_DIR =
  process.env.KARMAN_WORKER_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'karman');
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
  // Строка о старте задачи (мандат brain 19.11: «видно и задача идёт, и задача молчала»).
  // След за сам проход синхронизации пишет приложение в свой журнал.
  log('диспетчер напоминаний запущен, тик раз в', Math.round(DISPATCH_INTERVAL_MS / 1000), 'с');
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
/**
 * Курсор сторожа: до какой ВЫДАЧИ он уже смотрел (ISO).
 *
 * Сторож идёт по дереву выдачи вверх по времени (мадат владельца 18.11, 21:40 МСК):
 * от последней проверенной выдачи к новым — и не трогает выдачи моложе получаса
 * («возможно ещё в работе и проверять его ещё рано»).
 *
 * Хранится в файле состояния рядом с маркером забора: переживает рестарт воркера,
 * а потеря файла не страшна — проверки идемпотентны, просто пройдёт лишний раз.
 */
/**
 * Ежесуточный забор бонусов MiniMax (заказ владельца 18.11).
 *
 * Раз в сутки, в DAILY_BONUS_HOUR_MSK по Москве. Забор идемпотентен в сутки (вендор
 * отдаёт «уже получено»), поэтому лишний заход ничего не ломает — а вот ПРОПУСК захода
 * ломает: у аккаунта не сдвинется клетка, и серия дней подряд оборвётся.
 *
 * Поэтому на старте воркера: если час забора уже прошёл, а обхода за сегодня ещё не
 * было — забираем сразу (иначе после рестарта воркера сутки пропустили бы), а если ещё
 * нет — ждём расписания.
 *
 * Живая находка 18.11: прежний код ждал «часа забора» функцией, которая ВСЕГДА
 * возвращала время до ЗАВТРАШНЕГО 05:00 — потому что уже прошедший час откатывался на
 * сутки вперёд. Из-за этого «догон» при старте не срабатывал никогда, а упавший забор
 * (приложение ещё поднимается после деплоя) ждал до следующего дня: сутки обхода
 * просто терялись, и у аккаунтов не сдвигалась клетка вендора.
 *
 * Проверяем РАЗ В 30 МИНУТ, а не раз в сутки: маркер «обход завершён» пишет само
 * приложение — по факту завершения обхода, — и если обход начался и умер (деплой убил
 * процесс), маркера нет. Тогда следующая проверка (через полчаса) начнёт обход заново:
 * забор идемпотентен, лишних очков не начислится, а сутки не пропадут.
 */
function startDailyBonusLoop() {
  const tick = async () => {
    try {
      // Час забора наступил, а маркера «обход завершён» нет → обход не состоялся
      // (или умер на середине) → начинаем заново.
      if (shouldSweep()) {
        const res = await postInternal('/api/internal/minimax/daily-bonus', {});
        if (!res.ok) {
          log('daily-bonus HTTP', res.status, '— повтор через 30 мин');
          return;
        }
        log('daily-bonus: обход запущен');
      }
    } catch (error) {
      log('daily-bonus error', String(error), '— повтор через 30 мин');
    }
  };

  // Проверяем РАЗ В 30 МИНУТ, а не «спим до следующего 05:00»:
  //
  // Живая находка 20.11: воркер, поднятый после часа забора (деплой в 22:40),
  // засыпал до следующего 05:00 ОДНИМ длинным таймером — и таймер не выстрелил.
  // Забора за 20.11 не было: сутки клеток вендора потеряны, а две карусели остались
  // без класса очков (класс берётся из нашего забора).
  //
  // Теперь короткий опрос — страховка: маркер ставит приложение по факту завершения
  // обхода, поэтому обход, который начался и умер, не считается сделанным и будет
  // повторён. Плюс точный таймер на 05:00 МСК — чтобы обход начинался вовремя.
  setInterval(tick, DAILY_BONUS_CHECK_MS);
  setTimeout(tick, dailyBonusTimePassed() ? 0 : msUntilDailyBonus());
}

/**
 * Пора ли начинать ежесуточный обход: час забора наступил (по МОСКОВСКИМ суткам) и
 * маркера «обход завершён» нет.
 *
 * Чистая функция — под тест (scripts/reminders-worker.test.ts).
 */
function shouldSweep(now = new Date(), dir = STATE_DIR) {
  return dailyBonusTimePassed(now) && !sweepDoneToday(dir);
}

/** Московская дата сегодняшних суток (UTC+3; перехода на летнее время нет). */
function moscowDate(now = new Date()) {
  return new Date(now.getTime() + 3 * 60 * 60_000).toISOString().slice(0, 10);
}

/**
 * Маркер «обход за московские сутки завершён».
 *
 * ПИШЕТ ЕГО НЕ МЫ, а приложение — по факту завершения обхода
 * (`lib/services/minimax-sweep-marker.ts`): роут отвечает сразу, обход идёт в фоне, и
 * обход, который начался и умер (деплой убил процесс), не должен считаться сделанным.
 * Мы только читаем маркер — и если его нет, а час забора наступил, начинаем обход заново.
 *
 * Путь маркера тут повторён вручную (воркер едет в артефакт отдельным файлом и не может
 * импортировать код приложения) — это единственное намеренное дублирование.
 */
function sweepMarkerPath(date = moscowDate(), dir = STATE_DIR) {
  return path.join(dir, `daily-bonus-${date}.done`);
}

/** Был ли обход за сегодняшние московские сутки завершён (маркер от приложения). */
function sweepDoneToday(dir = STATE_DIR) {
  try {
    return fs.existsSync(sweepMarkerPath(moscowDate(), dir));
  } catch {
    return false;
  }
}

/**
 * Прошёл ли час забора (05:00) в ТЕКУЩИХ МОСКОВСКИХ сутках.
 *
 * Считаем по московской дате, а не по UTC: в 01:56 МСК это 22:56 предыдущих
 * суток по UTC, и наивная проверка «прошло ли 02:00 UTC сегодня» сказала бы
 * «да» — а забор в это время преждевременный: сутки потребителя (UTC) ещё не
 * начались (они с 03:00 МСК), и мы забрали бы клетку не того дня. Живая находка
 * 19.11, 01:56 МСК.
 */
function dailyBonusTimePassed(now = new Date()) {
  // 05:00 МСК московской даты в UTC — это 02:00 UTC того же календарного дня.
  const start = new Date(`${moscowDate(now)}T02:00:00.000Z`);
  return now.getTime() >= start.getTime();
}

/** Сколько миллисекунд до следующего DAILY_BONUS_HOUR_MSK по Москве (UTC+3). */
function msUntilDailyBonus(now = new Date()) {
  const hourUtc = (DAILY_BONUS_HOUR_MSK - 3 + 24) % 24;
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

// Запуск циклов — только когда файл запущен как программа. Импорт (тест) не должен
// поднимать таймеры и лонг-полл Telegram.
const isEntryPoint =
  typeof process.argv[1] === 'string' && /reminders-worker\.mjs$/.test(process.argv[1]);

if (isEntryPoint) {
  if (!TOKEN || !SECRET) {
    log('TELEGRAM_BOT_TOKEN / REMINDERS_INTERNAL_SECRET не заданы — простаиваю (настройте env).');
    setInterval(() => log('ожидаю настройки env...'), 10 * 60_000);
  } else {
    log(`старт: base=${BASE}, dispatch каждые ${DISPATCH_INTERVAL_MS}ms, забор бонусов в ${DAILY_BONUS_HOUR_MSK}:00 МСК, poll timeout ${POLL_TIMEOUT_S}s`);
    startDispatchLoop();
    startDailyBonusLoop();
    startPollLoop();
  }
}

// Чистые помощники расписания — под тест (scripts/reminders-worker.test.ts).
export {
  DAILY_BONUS_CHECK_MS,
  dailyBonusTimePassed,
  moscowDate,
  msUntilDailyBonus,
  shouldSweep,
  sweepDoneToday,
  sweepMarkerPath,
};
