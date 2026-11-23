import { describe, expect, it } from 'vitest';
import {
  issuableCounts,
  parseIssueDetail,
  trafficLines,
  type TrafficStats,
} from '@/lib/accounts/traffic';

/**
 * Гейт блока «Текучка» (заказ владельца 23.11): сколько аккаунтов в системе,
 * сколько потрачено сегодня, сколько осталось, и последние 10 выдач.
 *
 * Модуль чистый (его читает клиентский компонент страницы), поэтому здесь нет
 * БД: проверяются разбор строки аудита, счётчики «осталось» и подписи строк.
 */

/** Строка аудита выдачи в нынешнем формате (`lib/services/minimax.ts`). */
const AUDIT_DETAIL =
  'выдан аккаунт #153 «Матрица РМЗ — 12»: класс points_1000, клетка 7, ' +
  'очки 1000 (забор при выдаче, claim 1), access отдан, область programming, ' +
  'проект MatricaRMZ, жизнь access 720 мин';

describe('разбор строки аудита выдачи', () => {
  it('читает аккаунт, очки, область и проект', () => {
    const detail = parseIssueDetail(AUDIT_DETAIL);
    expect(detail.accountId).toBe(153);
    expect(detail.title).toBe('Матрица РМЗ — 12');
    expect(detail.points).toBe(1000);
    expect(detail.cell).toBe(7);
    expect(detail.tier).toBe('points_1000');
    expect(detail.area).toBe('programming');
    expect(detail.project).toBe('MatricaRMZ');
  });

  it('пустая строка — «не знаем», а не ноль', () => {
    const detail = parseIssueDetail(null);
    expect(detail.accountId).toBeNull();
    expect(detail.points).toBeNull();
    expect(detail.project).toBeNull();
  });

  it('старая строка без области и проекта разбирается частично', () => {
    const detail = parseIssueDetail(
      'выдан аккаунт #7 «тест»: класс points_400, клетка 4, очки 400, access отдан',
    );
    expect(detail.accountId).toBe(7);
    expect(detail.points).toBe(400);
    expect(detail.area).toBeNull();
    expect(detail.project).toBeNull();
  });

  it('слово «проект» из метки аккаунта не путается с проектом потребителя', () => {
    const detail = parseIssueDetail(
      'выдан аккаунт #9 «проект Матрица»: класс points_400, клетка 4, очки 400, ' +
        'access отдан, область programming, проект KARMAN, жизнь access 60 мин',
    );
    expect(detail.title).toBe('проект Матрица');
    expect(detail.project).toBe('KARMAN');
  });
});

describe('сколько аккаунтов можно выдать', () => {
  const NOW = new Date('2026-11-23T10:00:00Z');

  it('готовы и с целыми очками — одно и то же, пока очки не сожжены', () => {
    const counts = issuableCounts(
      [
        { id: 1, usedAt: null, bonusOurs: true, bonusRemaining: 400 },
        { id: 2, usedAt: null, bonusOurs: true, bonusRemaining: 1000 },
      ],
      NOW,
      [1, 2],
    );
    expect(counts.ready).toBe(2);
    expect(counts.withPoints).toBe(2);
  });

  it('аккаунт без добытой пары токенов отдавать нечего', () => {
    const counts = issuableCounts(
      [
        { id: 1, usedAt: null, bonusOurs: true, bonusRemaining: 400 },
        { id: 2, usedAt: null, bonusOurs: true, bonusRemaining: 400 },
      ],
      NOW,
      [1],
    );
    expect(counts.ready).toBe(1);
    expect(counts.withPoints).toBe(1);
  });

  it('занятый сессией и с исчерпанной неделей в счёт не идут', () => {
    const counts = issuableCounts(
      [
        { id: 1, usedAt: '2026-11-23T09:00:00.000Z', bonusOurs: true },
        { id: 2, usedAt: null, weekExhausted: true, bonusOurs: true },
        { id: 3, usedAt: null, bonusOurs: true },
      ],
      NOW,
      [1, 2, 3],
    );
    expect(counts.ready).toBe(1);
    expect(counts.withPoints).toBe(1);
  });

  it('свободный аккаунт с сожжёнными очками — в «готовых», но не в «с очками»', () => {
    const counts = issuableCounts(
      [
        // Клетку забрал потребитель (bonusOurs = false) — очки сгорели у него.
        { id: 1, usedAt: null, bonusOurs: false },
        { id: 2, usedAt: null, bonusOurs: true, bonusRemaining: 400 },
      ],
      NOW,
      [1, 2],
    );
    expect(counts.ready).toBe(2);
    expect(counts.withPoints).toBe(1);
  });
});

describe('строки блока «Текучка»', () => {
  const stats: TrafficStats = {
    label: '22.11 → 23.11',
    total: 215,
    spent: 57,
    handed: 52,
    handedPoints: 78_000,
    consumerTaken: 3,
    manual: 2,
    recent: [],
  };

  // Числа в подписях форматируются тем же локалем, что и весь интерфейс
  // (`toLocaleString('ru-RU')`): в нём разделитель тысяч — УЗКИЙ неразрывный
  // пробел, и руками набранный обычный пробел в строке не совпадёт.
  const num = (value: number): string => value.toLocaleString('ru-RU');

  it('называет окно суток явно', () => {
    const lines = trafficLines(stats, { ready: 158, withPoints: 141 });
    expect(lines[0]).toEqual({
      label: 'Сутки',
      value: '22.11 → 23.11 · окно 05:00 → 05:00 МСК',
    });
  });

  it('«всего» — про аккаунты в системе', () => {
    const lines = trafficLines(stats, { ready: 158, withPoints: 141 });
    expect(lines[1]).toEqual({ label: 'Всего', value: '215 аккаунтов в системе' });
  });

  it('«потрачено сегодня» — с разбивкой, откуда число', () => {
    const lines = trafficLines(stats, { ready: 158, withPoints: 141 });
    expect(lines[2]).toEqual({
      label: 'Потрачено сегодня',
      value:
        `57 аккаунтов — отдали 52 на ${num(78_000)} очков · клетку забрал потребитель — 3 · ` +
        'вручную владельцем — 2',
    });
  });

  it('«осталось» — сколько с очками и сколько просто готовы', () => {
    const lines = trafficLines(stats, { ready: 158, withPoints: 141 });
    expect(lines[3]).toEqual({
      label: 'Осталось',
      value: '141 с целыми очками (158 готовых к выдаче)',
    });
  });

  it('без ручных активаций группа не упоминается', () => {
    const lines = trafficLines(
      { ...stats, manual: 0 },
      { ready: 158, withPoints: 141 },
    );
    expect(lines[2]!.value).not.toContain('вручную');
  });

  it('окончание по числу — «1 аккаунт», а не «1 аккаунтов»', () => {
    const lines = trafficLines(
      { ...stats, total: 1, spent: 1, handed: 1, consumerTaken: 0, manual: 0 },
      { ready: 0, withPoints: 0 },
    );
    expect(lines[1]!.value).toBe('1 аккаунт в системе');
    expect(lines[3]!.value).toBe('0 с целыми очками (0 готовых к выдаче)');
  });
});
