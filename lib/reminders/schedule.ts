import { moscowLocalToUtcIso, utcToMoscowLocal } from './time';
import type { QuietHours, ScheduleSpec } from './types';

/**
 * Движок расписания: вычисляет следующее срабатывание (UTC-инстант, ISO) строго
 * ПОСЛЕ `afterIso`, либо null если серия завершена. Чистая функция — вся логика
 * повтора считается в МОСКОВСКОМ wall-clock (фиксированный UTC+3), затем
 * конвертируется в UTC. Тестируется матрицей в schedule.test.ts.
 *
 * `firedCount` — сколько срабатываний уже было (для end.afterN). При создании 0.
 * Тихие часы (`quietHours`) и только-рабочие-дни (`businessDaysOnly`) применяются
 * как монотонный сдвиг каждого кандидата ВПЕРЁД (см. adjustCandidate); cron /
 * relative — следующие итерации (P3+/P4).
 */

const MAX_OCCURRENCES = 1000;

type Ymd = { y: number; m: number; d: number }; // m: 1..12

function parseYmd(s: string): Ymd {
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)), d: Number(s.slice(8, 10)) };
}
function ymdToStr(v: Ymd): string {
  return `${v.y}-${String(v.m).padStart(2, '0')}-${String(v.d).padStart(2, '0')}`;
}
function ymdToTime(v: Ymd): number {
  return Date.UTC(v.y, v.m - 1, v.d);
}
function fromUtc(ms: number): Ymd {
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
function addDays(v: Ymd, n: number): Ymd {
  return fromUtc(ymdToTime(v) + n * 86_400_000);
}
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // день 0 след. месяца = последний день m
}
/** 0=Вс..6=Сб (как Date.getUTCDay). */
function weekday(v: Ymd): number {
  return new Date(ymdToTime(v)).getUTCDay();
}

const DAY_MS = 86_400_000;

/**
 * Московские даты серии (ascending). Перематывает к `notBefore` (дата ≈ afterIso),
 * иначе при далёком startDate серия из MAX_OCCURRENCES не дотягивала бы до настоящего
 * (баг: дайджест с якорем 2020 → next_fire null). С notBefore окно всегда у «сейчас».
 */
function recurringDates(spec: Extract<ScheduleSpec, { kind: 'recurring' }>, notBefore: Ymd): Ymd[] {
  const start = parseYmd(spec.startDate);
  const interval = Math.max(1, spec.interval);
  const startT = ymdToTime(start);
  const nbT = ymdToTime(notBefore);
  const out: Ymd[] = [];

  if (spec.freq === 'daily') {
    const k = nbT > startT ? Math.floor((nbT - startT) / DAY_MS / interval) : 0;
    let cur = addDays(start, k * interval);
    for (let i = 0; i < MAX_OCCURRENCES; i++) {
      if (ymdToTime(cur) >= startT) out.push(cur);
      cur = addDays(cur, interval);
    }
  } else if (spec.freq === 'weekly') {
    const weekdays = (spec.weekdays?.length ? spec.weekdays : [weekday(start)]).slice().sort((a, b) => a - b);
    const startMonday = addDays(start, -((weekday(start) + 6) % 7));
    const nbMonday = addDays(notBefore, -((weekday(notBefore) + 6) % 7));
    const blocks = Math.max(0, Math.floor((ymdToTime(nbMonday) - ymdToTime(startMonday)) / (7 * interval * DAY_MS)));
    let weekMonday = addDays(startMonday, blocks * 7 * interval);
    for (let w = 0; w < MAX_OCCURRENCES && out.length < MAX_OCCURRENCES; w++) {
      for (const wd of weekdays) {
        const date = addDays(weekMonday, (wd + 6) % 7);
        if (ymdToTime(date) >= startT) out.push(date);
      }
      weekMonday = addDays(weekMonday, 7 * interval);
    }
    out.sort((a, b) => ymdToTime(a) - ymdToTime(b));
  } else if (spec.freq === 'monthly') {
    const day = spec.monthday ?? start.d;
    const monthsElapsed = (notBefore.y - start.y) * 12 + (notBefore.m - start.m);
    const i0 = monthsElapsed > 0 ? Math.floor(monthsElapsed / interval) : 0;
    for (let i = i0; i < i0 + MAX_OCCURRENCES; i++) {
      const total = start.m - 1 + interval * i;
      const y = start.y + Math.floor(total / 12);
      const m = (total % 12) + 1;
      const cand: Ymd = { y, m, d: Math.min(day, daysInMonth(y, m)) };
      if (ymdToTime(cand) >= startT) out.push(cand);
    }
  } else {
    // yearly
    const i0 = notBefore.y > start.y ? Math.floor((notBefore.y - start.y) / interval) : 0;
    for (let i = i0; i < i0 + MAX_OCCURRENCES; i++) {
      const y = start.y + interval * i;
      out.push({ y, m: start.m, d: Math.min(start.d, daysInMonth(y, start.m)) });
    }
  }

  return out.slice(0, MAX_OCCURRENCES);
}

function toMinutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/**
 * Тихие часы: если московское время кандидата попадает в окно [from, to) — перенести
 * на `deferTo`. Окно может пересекать полночь (from > to, напр. 22:00..08:00): вечерняя
 * часть (t >= from) переносится на `deferTo` СЛЕДУЮЩЕГО дня, ночная (t < to) — текущего.
 * Возвращает скорректированные дату+время (всегда не раньше исходного момента).
 */
function applyQuietHours(date: Ymd, time: string, q: QuietHours): { date: Ymd; time: string } {
  const t = toMinutes(time);
  const from = toMinutes(q.from);
  const to = toMinutes(q.to);
  const wraps = from > to;
  const inQuiet = wraps ? t >= from || t < to : t >= from && t < to;
  if (!inQuiet) return { date, time };
  const nextDay = wraps && t >= from;
  return { date: nextDay ? addDays(date, 1) : date, time: q.deferTo };
}

/** Только рабочие дни: суббота/воскресенье → ближайший следующий будний день (то же время). */
function applyBusinessDays(date: Ymd): Ymd {
  let d = date;
  while (weekday(d) === 0 || weekday(d) === 6) d = addDays(d, 1);
  return d;
}

/**
 * Сдвиг кандидата по тихим часам и рабочим дням. Тихие часы первыми (могут перенести
 * на выходной), затем рабочие дни ловят выходной. Оба сдвига только вперёд — итоговый
 * UTC-инстант не меньше исходного, поэтому минимум по всем кандидатам корректен даже
 * если сдвиг меняет относительный порядок соседних кандидатов.
 */
function adjustCandidate(local: string, spec: ScheduleSpec): string {
  let date = parseYmd(local.slice(0, 10));
  let time = local.slice(11, 16);
  if (spec.quietHours) ({ date, time } = applyQuietHours(date, time, spec.quietHours));
  if (spec.businessDaysOnly) date = applyBusinessDays(date);
  return `${ymdToStr(date)}T${time}`;
}

/** Список московских wall-clock 'YYYY-MM-DDTHH:MM' по спеке (ascending). */
function localCandidates(spec: ScheduleSpec, notBefore: Ymd): string[] {
  switch (spec.kind) {
    case 'oneoff':
      return [spec.at];
    case 'dates': {
      const times = spec.times.length ? spec.times : ['09:00'];
      return spec.dates
        .flatMap((d) => times.map((t) => `${d}T${t}`))
        .sort();
    }
    case 'recurring':
      return recurringDates(spec, notBefore).map((v) => `${ymdToStr(v)}T${spec.time}`);
    case 'relative':
      return []; // P4 — доменная привязка
  }
}

/**
 * Ближайшие `count` срабатываний строго ПОСЛЕ `afterIso` (UTC ISO, ascending).
 * Итерирует computeNextFire, прокидывая каждый результат как новый `afterIso` и
 * наращивая firedCount (чтобы end.afterN считался корректно). Короче `count`, если
 * серия завершается раньше. Чистая — для предпросмотра «когда сработает» в UI.
 */
export function nextFires(
  spec: ScheduleSpec,
  afterIso: string,
  count: number,
  firedCount = 0,
): string[] {
  const out: string[] = [];
  let after = afterIso;
  let fired = firedCount;
  for (let i = 0; i < count; i++) {
    const next = computeNextFire(spec, after, fired);
    if (next === null) break;
    out.push(next);
    after = next;
    fired++;
  }
  return out;
}

export function computeNextFire(
  spec: ScheduleSpec,
  afterIso: string,
  firedCount: number,
): string | null {
  const end = spec.end;
  if (end?.type === 'afterN' && firedCount >= end.n) {
    return null;
  }
  const untilMs = end?.type === 'until' ? Date.parse(moscowLocalToUtcIso(`${end.until}T23:59`)) : null;
  const afterMs = Date.parse(afterIso);
  // Перемотка серии к «сейчас» (буфер −3 дня) — см. recurringDates.
  const notBefore = addDays(parseYmd(utcToMoscowLocal(afterIso).slice(0, 10)), -3);
  const adjusted = spec.quietHours || spec.businessDaysOnly;

  // Сдвиг тихих часов / рабочих дней может переставить соседние кандидаты местами,
  // поэтому без сдвигов оставляем быстрый путь (первый подходящий, кандидаты ascending),
  // а со сдвигами берём минимальный инстант среди всех (оба сдвига — только вперёд).
  let best: number | null = null;
  for (const local of localCandidates(spec, notBefore)) {
    const utc = moscowLocalToUtcIso(adjusted ? adjustCandidate(local, spec) : local);
    const ms = Date.parse(utc);
    if (ms <= afterMs) {
      continue;
    }
    if (untilMs !== null && ms > untilMs) {
      if (adjusted) continue;
      return null;
    }
    if (!adjusted) {
      return utc;
    }
    if (best === null || ms < best) {
      best = ms;
    }
  }
  return best === null ? null : new Date(best).toISOString();
}
