import { describe, expect, it } from 'vitest';
import { hotlinePostSchema, hotlinePresenceSchema, hotlineReadSchema } from '@/lib/hotline/validation';

describe('контракт relay', () => {
  it('комнаты: all, to-<метка>, room:<имя>; broadcast маппится клиентом в all', () => {
    for (const room of ['all', 'to-setka', 'to-KARMAN', 'room:trio']) {
      expect(hotlineReadSchema.safeParse({ room }).success, room).toBe(true);
    }
    for (const room of ['broadcast', 'to-', 'room:', 'setka', '', 'to-sara fan!']) {
      expect(hotlineReadSchema.safeParse({ room }).success, room).toBe(false);
    }
  });

  it('текст: 2000 — да, 2001 — нет, пустой — нет', () => {
    const base = { from: 'KARMAN', room: 'to-setka', kind: 'answer' as const };
    expect(hotlinePostSchema.safeParse({ ...base, text: 'x'.repeat(2000) }).success).toBe(true);
    expect(hotlinePostSchema.safeParse({ ...base, text: 'x'.repeat(2001) }).success).toBe(false);
    expect(hotlinePostSchema.safeParse({ ...base, text: '' }).success).toBe(false);
  });

  it('виды — шесть из спеки; call — поведение клиента, не вид', () => {
    const base = { from: 'KARMAN', room: 'all', text: 'ping' };
    for (const kind of ['question', 'answer', 'done', 'ping', 'wakeup', 'ack']) {
      expect(hotlinePostSchema.safeParse({ ...base, kind }).success, kind).toBe(true);
    }
    expect(hotlinePostSchema.safeParse({ ...base, kind: 'call' }).success).toBe(false);
  });

  it('чтение: since_id и limit по умолчанию, потолок limit 200', () => {
    const parsed = hotlineReadSchema.safeParse({ room: 'all' });
    expect(parsed.success && parsed.data.since_id).toBe(0);
    expect(parsed.success && parsed.data.limit).toBe(100);
    expect(hotlineReadSchema.safeParse({ room: 'all', limit: 201 }).success).toBe(false);
  });

  it('присутствие: alive_minutes 1..1440', () => {
    expect(
      hotlinePresenceSchema.safeParse({ label: 'KARMAN', alive_minutes: 60 }).success,
    ).toBe(true);
    expect(hotlinePresenceSchema.safeParse({ label: 'KARMAN', alive_minutes: 0 }).success).toBe(
      false,
    );
    expect(
      hotlinePresenceSchema.safeParse({ label: 'KARMAN', alive_minutes: 1441 }).success,
    ).toBe(false);
  });

  it('сторож: line_state опционально, только offline/on_line; тик без поля валиден', () => {
    const base = { label: 'KARMAN', alive_minutes: 60 };
    // Тик без поля — обычный heartbeat, состояние не трогает (G54).
    const plain = hotlinePresenceSchema.safeParse(base);
    expect(plain.success && plain.data.line_state).toBe(undefined);
    for (const line_state of ['offline', 'on_line']) {
      expect(hotlinePresenceSchema.safeParse({ ...base, line_state }).success, line_state).toBe(
        true,
      );
    }
    for (const line_state of ['busy', 'online', '', 'на проводе']) {
      expect(hotlinePresenceSchema.safeParse({ ...base, line_state }).success, line_state).toBe(
        false,
      );
    }
  });
});
