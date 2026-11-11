import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import { prompt } from '@/lib/db/schema';
import {
  createPrompt,
  listPrompts,
  purgeArchivedPrompts,
  setPromptArchived,
} from '@/lib/services/prompts';
import {
  promptCreateSchema,
  promptIdSchema,
  promptPurgeSchema,
} from '@/lib/validation/prompt';
import type { SessionUser } from '@/lib/auth/rbac';

/**
 * G54 — живой round-trip контракта библиотеки промтов (тип → клиент → валидатор →
 * сервис → хранилище → обратное чтение).
 *
 * Зачем отдельным файлом, а не в `lib/services/prompts.test.ts`: тот бьёт по
 * сервисам напрямую и минует слой валидации, а именно он молча срезает новые
 * optional-поля (строгая/strip-схема). Юнит-зелёный это НЕ ловит — ловит
 * только прогон полной цепочки через настоящие схемы.
 *
 * Правило G54 срабатывает по событию «контракт расширился optional-полем»:
 * каждый раз, когда в `lib/validation/prompt.ts` появляется новое поле, сюда
 * добавляется проверка, что оно доезжает до БД и читается обратно.
 *
 * Дыра, которую гейт закрывает (найдена пробой 11.11): контракт промтов
 * жил с 06.11 без round-trip-гейта вообще — ни одного теста не импортирует
 * `lib/validation/prompt.ts`. Для контракта аккаунтов такой гейт есть
 * (`lib/accounts/contract.test.ts`), и именно он в 03.11 поймал, что
 * `lib/services/accounts.test.ts` минует валидацию.
 *
 * Изоляция: своя БД на файл, не на тест (холодный бут pglite поднимает ВСЮ
 * схему заново — десяток бутов подряд роняет гейт по таймауту хука).
 * Тесты не мешают друг другу: у каждого свои разделы и свои id промтов.
 */
const refs = vi.hoisted(() => ({ current: undefined as TestDb | undefined }));
vi.mock('@/lib/db/client', () => ({
  get db() {
    return refs.current;
  },
}));

let pg: PGlite | undefined;

const owner: SessionUser = {
  id: 1,
  username: 'admin',
  email: '',
  firstName: '',
  lastName: '',
  isSuperuser: true,
};

beforeAll(async () => {
  const t = await createTestDb();
  pg = t.pg;
  refs.current = t.db;
});

afterAll(async () => {
  refs.current = undefined;
  await pg?.close();
});

describe('G54: контракт промтов проходит все слои целиком', () => {
  it('create: необязательный заголовок без значения — производный от текста, и он в БД', async () => {
    // Клиент присылает раздел и текст, без заголовка (форма импорта, голосовой
    // ввод). Схема без default срезала бы поле — и заголовок молча пропал бы.
    const payload = { project: 'G54A', body: 'Напиши ТЗ для кассы\nвторой строкой' };
    const parsed = promptCreateSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // Заголовок optional — и optional с default: пустое значение допустимо.
    expect(parsed.data.title).toBe('');

    // createPrompt возвращает САМ промт, а не id — id достаём из него.
    const созданный = await createPrompt(owner, parsed.data, 'manual');
    const id = созданный.id;
    const [row] = await refs.current!
      .select()
      .from(prompt)
      .where(eq(prompt.id, id));
    expect(row!.project).toBe('G54A');
    expect(row!.title).toBe('Напиши ТЗ для кассы');
    expect(row!.body).toBe('Напиши ТЗ для кассы\nвторой строкой');

    // Обратное чтение: заголовок виден в списке, а не потерялся по дороге.
    const list = await listPrompts(owner, { archived: false, project: 'G54A' });
    expect(list.find((r) => r.id === id)!.title).toBe('Напиши ТЗ для кассы');
  });

  it('create: заданный заголовок доезжает до БД и читается обратно', async () => {
    const payload = { project: 'G54B', title: 'Своё имя', body: 'Текст' };
    const parsed = promptCreateSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.title).toBe('Своё имя');

    const созданный = await createPrompt(owner, parsed.data, 'manual');
    const id = созданный.id;
    const [row] = await refs.current!
      .select()
      .from(prompt)
      .where(eq(prompt.id, id));
    expect(row!.title).toBe('Своё имя');
  });

  it('create: имя раздела с пробелами обрезается и доезжает как есть', async () => {
    const parsed = promptCreateSchema.safeParse({ project: '  G54C  ', body: 'Текст' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.project).toBe('G54C');

    const созданный = await createPrompt(owner, parsed.data, 'manual');
    const id = созданный.id;
    const [row] = await refs.current!
      .select()
      .from(prompt)
      .where(eq(prompt.id, id));
    expect(row!.project).toBe('G54C');
  });

  it('purge: БЕЗ даты удаляются ВСЕ архивные, живые целы', async () => {
    // Пустое значение optional-поля — это отдельная семантика: «очистить весь
    // свой архив». Если бы поле срезалось до undefined у даты, то запрос
    // «удалить старше даты» удалял бы ВСЁ — разница разрушительная, и
    // юнит-тест сервиса её не видит.
    const parsed = promptPurgeSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.before).toBeUndefined();

    const old1 = (await createPrompt(owner, { project: 'G54D', body: 'Старый' }, 'manual')).id;
    const old2 = (await createPrompt(owner, { project: 'G54D', body: 'Тоже старый' }, 'manual')).id;
    const live = (await createPrompt(owner, { project: 'G54D', body: 'Живой' }, 'manual')).id;
    await setPromptArchived(owner, old1, true);
    await setPromptArchived(owner, old2, true);

    const removed = await purgeArchivedPrompts(owner, parsed.data.before);
    expect(removed).toBe(2);

    const после = await listPrompts(owner, { archived: false, project: 'G54D' });
    expect(после.map((r) => r.id)).toEqual([live]);
    const архив = await listPrompts(owner, { archived: true, project: 'G54D' });
    expect(архив).toHaveLength(0);
  });

  it('purge: с датой удаляются только более старые архивные (разница разрушительная)', async () => {
    const parsed = promptPurgeSchema.safeParse({ before: '2026-03-01' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.before).toBe('2026-03-01');

    const старый = (await createPrompt(owner, { project: 'G54E', body: 'Старый' }, 'manual')).id;
    const свежий = (await createPrompt(owner, { project: 'G54E', body: 'Свежий' }, 'manual')).id;
    const живой = (await createPrompt(owner, { project: 'G54E', body: 'Живой' }, 'manual')).id;
    await setPromptArchived(owner, старый, true);
    await setPromptArchived(owner, свежий, true);
    // Дату архивации задаём руками: сервис ставит «сейчас», а для проверки
    // границы нужна строка ЗАВЕДОМО старше указанной даты.
    await refs.current!
      .update(prompt)
      .set({ archivedAt: '2026-01-15T00:00:00.000Z' })
      .where(eq(prompt.id, старый));
    await refs.current!
      .update(prompt)
      .set({ archivedAt: '2026-06-15T00:00:00.000Z' })
      .where(eq(prompt.id, свежий));

    const removed = await purgeArchivedPrompts(owner, parsed.data.before);
    expect(removed).toBe(1);

    const после = await listPrompts(owner, { archived: false, project: 'G54E' });
    expect(после.map((r) => r.id)).toEqual([живой]);
    const архив = await listPrompts(owner, { archived: true, project: 'G54E' });
    expect(архив.map((r) => r.id)).toEqual([свежий]);
  });

  it('purge: неверная дата отвергается валидатором (формат ГГГГ-ММ-ДД)', async () => {
    const bad = promptPurgeSchema.safeParse({ before: '01.03.2026' });
    expect(bad.success).toBe(false);
    const empty = promptPurgeSchema.safeParse({ before: '' });
    expect(empty.success).toBe(false);
  });

  it('archive: id приходит строкой из формы — приводится к числу и промт архивируется', async () => {
    // Клиент шлёт id строкой (значение из input). Без coerce сравнение
    // eq(prompt.id, '42') не нашло бы строку — и архивирование молча
    // ничего бы не сделало.
    const созданный = await createPrompt(owner, { project: 'G54F', body: 'Текст' }, 'manual');
    const id = созданный.id;
    const parsed = promptIdSchema.safeParse(String(id));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toBe(id);
    expect(typeof parsed.data).toBe('number');

    expect(await setPromptArchived(owner, parsed.data, true)).toBe(true);
    const живые = await listPrompts(owner, { archived: false, project: 'G54F' });
    expect(живые).toHaveLength(0);
    const архив = await listPrompts(owner, { archived: true, project: 'G54F' });
    expect(архив.map((r) => r.id)).toEqual([id]);
  });

  it('archive: id вне диапазона отвергается валидатором', async () => {
    expect(promptIdSchema.safeParse('abc').success).toBe(false);
    expect(promptIdSchema.safeParse(0).success).toBe(false);
    expect(promptIdSchema.safeParse(-1).success).toBe(false);
  });

  it('create: пустое тело отвергается валидатором', async () => {
    expect(promptCreateSchema.safeParse({ project: 'G54G', body: '' }).success).toBe(false);
  });

  it('ОТРИЦАТЕЛЬНЫЙ КОНТРОЛЬ: схема срезает неизвестное поле — поэтому новое optional-поле обязано быть в схеме', async () => {
    // Если сервис начнёт читать поле, которого нет в схеме, значение пропадёт
    // МОЛЧА: strip-схема выкинет ключ, а юнит-тест сервиса (обходит валидатор)
    // останется зелёным. Этот тест фиксирует сам факт срезания — чтобы гейт
    // не выглядел декоративным.
    const parsed = promptCreateSchema.safeParse({
      project: 'G54H',
      body: 'Текст',
      title: 'Имя',
      archivedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // Известные поля на месте — их и проверяет round-trip выше.
    expect(parsed.data.project).toBe('G54H');
    expect(parsed.data.title).toBe('Имя');
    // Неизвестное — срезано, а не отвергнуто: вот где и рождается дрейф.
    expect('archivedAt' in parsed.data).toBe(false);
  });
});
