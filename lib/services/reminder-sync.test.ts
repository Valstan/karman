import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import { authUser, reminder, telegramLink } from '@/lib/db/schema';
import {
  reconcileDomainReminders,
  reminderSyncEnabled,
} from '@/lib/services/reminder-sync';
import { RULE_DIGEST } from '@/lib/reminders/domain-templates';

/**
 * Гейт следа за синхронизацией доменных напоминаний (мандат brain 19.11, портретный
 * разбор D-238).
 *
 * «Синхронизация доменных напоминаний раз в 25 секунд пишет и удаляет строки в прод-БД,
 * и следа нет: роут отдаёт JSON и в консоль не пишет, воркер логирует только ошибку».
 * Просят след на КАЖДЫЙ проход, выключатель рядом с задачей и тест, который падает,
 * если задача снова станет молчаливой. Этот тест — тот самый страж.
 */
const refs = vi.hoisted(() => ({ current: undefined as TestDb | undefined }));
vi.mock('@/lib/db/client', () => ({
  get db() {
    return refs.current;
  },
}));

let pg: PGlite | undefined;
let logs: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn> | undefined;

const OWNER_ID = 1; // admin из scripts/bootstrap.sql

beforeEach(async () => {
  const t = await createTestDb();
  pg = t.pg;
  refs.current = t.db;
  logs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  });
});

afterEach(async () => {
  logSpy?.mockRestore();
  delete process.env.REMINDER_SYNC_ENABLED;
  await pg?.close();
});

/** Пользователь с активным чатом (получает дайджест). Админ уже есть в тестовой БД. */
async function linkedUser() {
  await refs.current!
    .insert(telegramLink)
    .values({ userId: OWNER_ID, chatId: 42, isActive: true });
}

/** Пользователь без чата (его дайджест должен быть удалён). */
async function unlinkedUser(userId: number) {
  await refs.current!
    .insert(authUser)
    .values({
      id: userId,
      username: `u${userId}`,
      password: 'x',
      email: `u${userId}@example.test`,
    })
    .onConflictDoNothing();
  await refs.current!
    .insert(reminder)
    .values({
      userId,
      title: 'Сводка KARMAN',
      bodyTemplate: '',
      sourceType: 'digest',
      ruleId: RULE_DIGEST,
      priority: 'normal',
      silent: false,
      status: 'active',
    });
}

describe('синхронизация доменных напоминаний: след, выключатель, страж', () => {
  it('пишет след на КАЖДЫЙ проход — даже когда ничего не изменилось', async () => {
    await linkedUser();
    // Первый проход создаст дайджест, второй ничего не изменит — след обязан быть оба раза.
    await reconcileDomainReminders();
    logs.length = 0;
    await reconcileDomainReminders();

    const trace = logs.filter((line) => line.includes('синхронизация доменных напоминаний'));
    expect(trace).toHaveLength(1);
    expect(trace[0]).toContain('удалено 0');
    expect(trace[0]).toContain('создано 0');
  });

  it('выключатель REMINDER_SYNC_ENABLED снимает задачу и говорит об этом следом', async () => {
    await linkedUser();
    process.env.REMINDER_SYNC_ENABLED = '0';

    const result = await reconcileDomainReminders();

    expect(result.disabled).toBe(true);
    expect(result.created).toBe(0);
    expect(logs.some((line) => line.includes('выключена'))).toBe(true);
    // В базе дайджеста нет — задача действительно снята.
    const rows = await refs.current!
      .select({ id: reminder.id })
      .from(reminder)
      .where(eq(reminder.sourceType, 'digest'));
    expect(rows).toHaveLength(0);
  });

  it('выключатель по умолчанию включён, а явное «0» выключает', () => {
    expect(reminderSyncEnabled()).toBe(true);
    process.env.REMINDER_SYNC_ENABLED = '0';
    expect(reminderSyncEnabled()).toBe(false);
    process.env.REMINDER_SYNC_ENABLED = 'false';
    expect(reminderSyncEnabled()).toBe(false);
    process.env.REMINDER_SYNC_ENABLED = '1';
    expect(reminderSyncEnabled()).toBe(true);
  });

  it('создаёт дайджест привязанному и удаляет дайджест отвязавшегося', async () => {
    await linkedUser();
    await unlinkedUser(99);

    const result = await reconcileDomainReminders();

    expect(result.created).toBe(1);
    expect(result.deleted).toBe(1);
    const rows = await refs.current!
      .select({ userId: reminder.userId })
      .from(reminder)
      .where(eq(reminder.sourceType, 'digest'));
    expect(rows.map((row) => row.userId)).toEqual([OWNER_ID]);
  });

  it('страж: след пишется всегда — тест падает, если его убрать', async () => {
    await linkedUser();
    await reconcileDomainReminders();
    // Проверка не «логика, а лог»: если строка следа исчезнет — падаем.
    const hasTrace = logs.some((line) => line.includes('синхронизация доменных напоминаний'));
    expect(hasTrace).toBe(true);
    expect(logs.some((line) => line.includes('удалено'))).toBe(true);
  });
});
