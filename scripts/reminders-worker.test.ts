import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// @ts-expect-error .mjs без деклараций — импортируем как есть (мандат brain 2026-09-09).
import { dailyBonusTimePassed, markSweepDone, moscowDate, msUntilDailyBonus, sweepDoneToday, sweepMarkerPath } from './reminders-worker.mjs';

// Расписание ежесуточного забора бонусов MiniMax (живая находка 18.11).
//
// Прежняя функция «сколько до следующего 05:00 МСК» ВСЕГДА возвращала время до
// ЗАВТРАШНЕГО забора: уже прошедший час откатывался на сутки вперёд. Из-за этого
// «догон» при старте воркера не срабатывал никогда, а упавший забор ждал до
// следующего дня — сутки обхода терялись целиком.

describe('расписание ежесуточного забора', () => {
  it('час забора (05:00 МСК = 02:00 UTC) считается пройденным после себя', () => {
    expect(dailyBonusTimePassed(new Date('2026-11-18T01:59:59Z'))).toBe(false);
    expect(dailyBonusTimePassed(new Date('2026-11-18T02:00:00Z'))).toBe(true);
    expect(dailyBonusTimePassed(new Date('2026-11-18T15:30:00Z'))).toBe(true);
  });

  it('ночью догон НЕ срабатывает: час забора считается по МОСКОВСКИМ суткам', () => {
    // Живая находка 19.11, 01:56 МСК: это 22:56 предыдущих суток по UTC. Наивная
    // проверка «прошло ли 02:00 UTC сегодня» сказала бы «да» — и забор пошёл бы
    // после полуночи, когда сутки потребителя (UTC) ещё не начались (они с 03:00 МСК).
    // Мы бы забрали клетку не того дня — ровно то ночное окно, из-за которого забор
    // стоит в 05:00.
    expect(dailyBonusTimePassed(new Date('2026-11-18T22:56:00Z'))).toBe(false); // 01:56 МСК
    expect(dailyBonusTimePassed(new Date('2026-11-19T01:00:00Z'))).toBe(false); // 04:00 МСК
    expect(dailyBonusTimePassed(new Date('2026-11-19T02:00:00Z'))).toBe(true); // 05:00 МСК
    expect(dailyBonusTimePassed(new Date('2026-11-19T02:30:00Z'))).toBe(true); // 05:30 МСК
  });

  it('до следующего забора — положительное время, и оно ведёт к 05:00 МСК', () => {
    // 03:00 UTC = 06:00 МСК — час уже прошёл, значит следующий забор завтра в 05:00 МСК
    // (02:00 UTC следующих суток): это 23 часа.
    const after = msUntilDailyBonus(new Date('2026-11-18T03:00:00Z'));
    expect(after).toBe(23 * 60 * 60_000);

    // 00:30 UTC = 03:30 МСК — до сегодняшнего 05:00 МСК ещё 1.5 часа.
    const before = msUntilDailyBonus(new Date('2026-11-18T00:30:00Z'));
    expect(before).toBe(90 * 60_000);

    // 22:56 UTC = 01:56 МСК — до забора в 05:00 МСК (02:00 UTC) осталось ~3 часа.
    const night = msUntilDailyBonus(new Date('2026-11-18T22:56:00Z'));
    expect(night).toBe(3 * 60 * 60_000 + 4 * 60_000);
  });

  it('московские сутки считаются по UTC+3, а не по дате UTC', () => {
    // 22:30 UTC — в Москве уже следующие сутки.
    expect(moscowDate(new Date('2026-11-17T22:30:00Z'))).toBe('2026-11-18');
    expect(moscowDate(new Date('2026-11-18T20:59:00Z'))).toBe('2026-11-18');
  });
});

describe('маркер «обход за сутки уже был»', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karman-worker-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('до обхода маркера нет, после — обход считается сделанным', () => {
    expect(sweepDoneToday(dir)).toBe(false);
    markSweepDone(dir);
    expect(sweepDoneToday(dir)).toBe(true);
  });

  it('имя маркера содержит московскую дату суток', () => {
    const file = sweepMarkerPath('2026-11-18', dir);
    expect(path.basename(file)).toBe('daily-bonus-2026-11-18.done');
    expect(path.dirname(file)).toBe(dir);
  });
});
