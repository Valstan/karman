import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepMarkerPath, writeSweepMarker } from '@/lib/services/minimax-sweep-marker';

/**
 * Маркер «ежесуточный обход завершён» (заказ владельца 18.11, доработка 19.11).
 *
 * Ключевое свойство: маркер ставит ПРИЛОЖЕНИЕ и только по факту завершения обхода.
 * Раньше его писал воркер сразу по ответу роута (а роут отвечает мгновенно: обход идёт
 * в фоне) — из-за этого обход, который начался и умер (деплой убил процесс), считался
 * сделанным, и сутки терялись: у части аккаунтов не было строки леджера, клетка вендора
 * не сдвигалась, серия дней рвалась.
 */
describe('маркер ежесуточного обхода', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karman-sweep-marker-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('маркер пишется по дате московских суток', () => {
    writeSweepMarker('2026-11-19', dir);
    expect(existsSync(join(dir, 'daily-bonus-2026-11-19.done'))).toBe(true);
    expect(sweepMarkerPath('2026-11-19', dir)).toBe(join(dir, 'daily-bonus-2026-11-19.done'));
  });

  it('каталог состояния создаётся, если его нет', () => {
    const nested = join(dir, 'state', 'karman');
    writeSweepMarker('2026-11-19', nested);
    expect(existsSync(join(nested, 'daily-bonus-2026-11-19.done'))).toBe(true);
  });

  it('разные сутки — разные маркеры', () => {
    writeSweepMarker('2026-11-18', dir);
    writeSweepMarker('2026-11-19', dir);
    expect(existsSync(join(dir, 'daily-bonus-2026-11-18.done'))).toBe(true);
    expect(existsSync(join(dir, 'daily-bonus-2026-11-19.done'))).toBe(true);
  });
});
