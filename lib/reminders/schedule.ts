import { moscowLocalToUtcIso, utcToMoscowLocal } from './time';
import type { ScheduleSpec } from './types';

/**
 * Движок расписания: вычисляет следующее срабатывание (UTC-инстант, ISO) строго
 * ПОСЛЕ `afterIso`, либо null если серия завершена. Чистая функция — вся логика
 * повтора считается в МОСКОВСКОМ wall-clock (фиксированный UTC+3), затем
 * конвертируется в UTC. Тестируется матрицей в schedule.test.ts.
 *
 * `firedCount` — сколько срабатываний уже было (для end.afterN). При создании 0.
 * Тихие часы / только-рабочие-дни / cron / relative — следующие итерации (P3+/P4).
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

  for (const local of localCandidates(spec, notBefore)) {
    const utc = moscowLocalToUtcIso(local);
    const ms = Date.parse(utc);
    if (ms <= afterMs) {
      continue;
    }
    if (untilMs !== null && ms > untilMs) {
      return null;
    }
    return utc;
  }
  return null;
}
