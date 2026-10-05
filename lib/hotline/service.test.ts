import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import { hotlinePresence } from '@/lib/db/schema';
import {
  heartbeatPresence,
  readPresence,
  sweepStaleLines,
  HOTLINE_STALE_AFTER_MS,
} from '@/lib/hotline/service';

/**
 * R1, первые тесты с БД: инварианты сторожа линии, а не CRUD.
 * Подмена — `vi.mock('@/lib/db/client')` (см. `lib/db/test-db.ts`):
 * прод-код сервисов не тронут.
 */
const refs = vi.hoisted(() => ({ current: undefined as TestDb | undefined }));
vi.mock('@/lib/db/client', () => ({
  get db() {
    return refs.current;
  },
}));

let pg: PGlite | undefined;

beforeEach(async () => {
  const t = await createTestDb();
  pg = t.pg;
  refs.current = t.db;
});

afterEach(async () => {
  refs.current = undefined;
  await pg?.close();
});

describe('сторож линии: состояние пишется событием', () => {
  it('pickup новой метки ставит on_line (регрессия живого #200)', async () => {
    // Первая строка метки идёт путём INSERT — событие терялось в дефолте
    // колонки, живая проба 05.10 отвечала 'offline'. Этот тест падает на том
    // коде в local, а не на проде.
    const done = await heartbeatPresence('KARMAN', 60, 'on_line');
    expect(done.line_state).toBe('on_line');
  });

  it('тик без поля не трогает состояние (G54)', async () => {
    await heartbeatPresence('KARMAN', 60, 'on_line');
    const done = await heartbeatPresence('KARMAN', 60);
    expect(done.line_state).toBe('on_line');
    const off = await heartbeatPresence('setka', 60, 'offline');
    expect(off.line_state).toBe('offline');
  });
});

describe('сторож линии: два пропуска — авто-отбой', () => {
  /** Состарить последний тик метки на ms (прямая правка таблицы в тесте). */
  async function ageTick(label: string, ms: number) {
    const db = refs.current!;
    await db
      .update(hotlinePresence)
      .set({ updatedAt: new Date(Date.now() - ms).toISOString() })
      .where(eq(hotlinePresence.label, label));
  }

  it('sweep гасит протухший on_line и щадит остальных', async () => {
    await heartbeatPresence('STALE', 60, 'on_line');
    await heartbeatPresence('FRESH', 60, 'on_line');
    await heartbeatPresence('IDLE', 60, 'offline');
    await ageTick('STALE', HOTLINE_STALE_AFTER_MS + 1000);
    await ageTick('IDLE', HOTLINE_STALE_AFTER_MS * 10);

    const swept = await sweepStaleLines();
    expect(swept).toBe(1);

    const rows = await readPresence();
    const state = new Map(rows.map((r) => [r.label, r.lineState]));
    expect(state.get('STALE')).toBe('offline');
    expect(state.get('FRESH')).toBe('on_line');
    expect(state.get('IDLE')).toBe('offline');
  });

  it('один пропуск — терпим (сеть чихнула, сессия жива)', async () => {
    await heartbeatPresence('JITTER', 60, 'on_line');
    await ageTick('JITTER', HOTLINE_STALE_AFTER_MS - 5000);
    expect(await sweepStaleLines()).toBe(0);
    const rows = await readPresence();
    expect(rows.find((r) => r.label === 'JITTER')?.lineState).toBe('on_line');
  });
});
