import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import type { SessionUser } from '@/lib/auth/rbac';
import {
  countArchivedPrompts,
  createPrompt,
  deletePrompt,
  listPromptSections,
  listPrompts,
  purgeArchivedPrompts,
  renamePromptProject,
  resolveOwnerAccountId,
  setPromptArchived,
  summarizePromptProjects,
  syncPromptProjects,
} from '@/lib/services/prompts';

/**
 * Библиотека промтов: инварианты, ради которых и делалась (заказ владельца
 * 2026-11-06).
 *
 * 1. Разделы — по проектам: промт попадает в свой проект, сводка считает их.
 * 2. Библиотека ЛИЧНАЯ: чужой промт не виден, не архивируется и не удаляется.
 *    Это главное правило — «информация у каждого аккаунта видна только ему».
 * 3. Архив — НЕ удаление: строка остаётся, у неё появляется дата архивации,
 *    и вернуть её можно одной кнопкой.
 * 4. Очистка архива трогает ТОЛЬКО своё архивное: живые промты не должны
 *    пропасть от «очистить архив» — это ровно тот класс ошибки, из-за которого
 *    у владельца пропала бы работа.
 * 5. Тело промта нормализуется при записи (форма), а смысл не трогается.
 */
const refs = vi.hoisted(() => ({ current: undefined as TestDb | undefined }));
vi.mock('@/lib/db/client', () => ({
  get db() {
    return refs.current;
  },
}));

let pg: PGlite | undefined;
let owner: SessionUser;
let other: SessionUser;

beforeEach(async () => {
  const t = await createTestDb();
  pg = t.pg;
  refs.current = t.db;
  // bootstrap.sql засевает админа (id 1). Второй пользователь нужен, чтобы
  // проверить изоляцию: чужой промт не должен быть виден.
  const rows = await t.pg.query<{ id: number }>(
    "INSERT INTO auth_user (password, username, is_superuser, is_active) VALUES ('x', 'chaka', FALSE, TRUE) RETURNING id",
  );
  owner = {
    id: 1,
    username: 'admin',
    email: '',
    firstName: '',
    lastName: '',
    isSuperuser: true,
  };
  other = {
    id: rows.rows[0]!.id,
    username: 'chaka',
    email: '',
    firstName: '',
    lastName: '',
    isSuperuser: false,
  };
});

afterEach(async () => {
  refs.current = undefined;
  await pg?.close();
});

describe('библиотека промтов', () => {
  it('новый промт попадает в свой проект и виден в живых', async () => {
    await createPrompt(owner, { project: 'Карман', body: 'Напиши ТЗ для кассы' });
    const живые = await listPrompts(owner, { archived: false });
    expect(живые).toHaveLength(1);
    expect(живые[0]!.project).toBe('Карман');
    expect(живые[0]!.archivedAt).toBeNull();
    expect(живые[0]!.source).toBe('manual');
  });

  it('заголовок без явного — первая строка промта', async () => {
    const создан = await createPrompt(owner, { project: 'Карман', body: 'Проверь чеки\nи сверь' });
    expect(создан.title).toBe('Проверь чеки');
  });

  it('текст нормализуется при записи: CRLF и висячие пробелы уходят', async () => {
    const создан = await createPrompt(owner, { project: 'Карман', body: 'Первый\r\n\r\n\r\nВторой  ' });
    expect(создан.body).toBe('Первый\n\nВторой');
  });

  it('промт от Мозга помечается источником brain', async () => {
    const создан = await createPrompt(owner, { project: 'Карман', body: 'Текст' }, 'brain');
    expect(создан.source).toBe('brain');
  });

  it('разделы считаются по проектам', async () => {
    await createPrompt(owner, { project: 'Карман', body: 'Один' });
    await createPrompt(owner, { project: 'Карман', body: 'Два' });
    await createPrompt(owner, { project: 'Setka', body: 'Три' });
    const сводка = await summarizePromptProjects(owner);
    // Порядок разделов — по кодам символов в нижнем регистре: латиница встаёт
    // перед кириллицей ('s' < 'к'), поэтому Setka выше Кармана.
    expect(сводка).toEqual([
      { project: 'Setka', count: 1 },
      { project: 'Карман', count: 2 },
    ]);
  });

  it('чужая библиотека не видна', async () => {
    await createPrompt(owner, { project: 'Карман', body: 'Секрет владельца' });
    expect(await listPrompts(other, { archived: false })).toHaveLength(0);
    expect(await summarizePromptProjects(other)).toEqual([]);
    expect(await countArchivedPrompts(other)).toBe(0);
  });

  it('чужой промт не архивируется и не удаляется', async () => {
    const мой = await createPrompt(owner, { project: 'Карман', body: 'Текст' });
    expect(await setPromptArchived(other, мой.id, true)).toBe(false);
    expect(await deletePrompt(other, мой.id)).toBe(false);
    const живые = await listPrompts(owner, { archived: false });
    expect(живые).toHaveLength(1);
  });

  it('архив убирает промт из живых, но не удаляет его', async () => {
    const создан = await createPrompt(owner, { project: 'Карман', body: 'Текст' });
    expect(await setPromptArchived(owner, создан.id, true)).toBe(true);

    expect(await listPrompts(owner, { archived: false })).toHaveLength(0);
    const архив = await listPrompts(owner, { archived: true });
    expect(архив).toHaveLength(1);
    expect(архив[0]!.archivedAt).not.toBeNull();
    expect(архив[0]!.body).toBe('Текст');
  });

  it('архивный промт возвращается в живые', async () => {
    const создан = await createPrompt(owner, { project: 'Карман', body: 'Текст' });
    await setPromptArchived(owner, создан.id, true);
    expect(await setPromptArchived(owner, создан.id, false)).toBe(true);
    expect(await listPrompts(owner, { archived: false })).toHaveLength(1);
    expect(await listPrompts(owner, { archived: true })).toHaveLength(0);
  });

  it('несуществующий промт не архивируется и не удаляется', async () => {
    expect(await setPromptArchived(owner, 999_999, true)).toBe(false);
    expect(await deletePrompt(owner, 999_999)).toBe(false);
  });

  it('удаление из архива убирает строку насовсем', async () => {
    const создан = await createPrompt(owner, { project: 'Карман', body: 'Текст' });
    await setPromptArchived(owner, создан.id, true);
    expect(await deletePrompt(owner, создан.id)).toBe(true);
    expect(await listPrompts(owner, { archived: true })).toHaveLength(0);
  });

  it('очистка архива не трогает живые промты', async () => {
    const живой = await createPrompt(owner, { project: 'Карман', body: 'Живой' });
    const вАрхиве = await createPrompt(owner, { project: 'Карман', body: 'В архиве' });
    await setPromptArchived(owner, вАрхиве.id, true);

    expect(await purgeArchivedPrompts(owner)).toBe(1);
    expect(await countArchivedPrompts(owner)).toBe(0);
    const осталось = await listPrompts(owner, { archived: false });
    expect(осталось).toHaveLength(1);
    expect(осталось[0]!.id).toBe(живой.id);
  });

  it('очистка архива не трогает чужой архив', async () => {
    const чужой = await createPrompt(other, { project: 'Карман', body: 'Чужое' });
    await setPromptArchived(other, чужой.id, true);

    expect(await purgeArchivedPrompts(owner)).toBe(0);
    expect(await listPrompts(other, { archived: true })).toHaveLength(1);
  });

  it('очистка по дате трогает только то, что старше даты', async () => {
    const старый = await createPrompt(owner, { project: 'Карман', body: 'Старый' });
    const свежий = await createPrompt(owner, { project: 'Карман', body: 'Свежий' });
    await setPromptArchived(owner, старый.id, true);
    await setPromptArchived(owner, свежий.id, true);

    // Дата «завтра» — оба архивных старше неё, «вчера» — оба моложе.
    const будущее = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const прошлое = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(await purgeArchivedPrompts(owner, будущее)).toBe(2);
    expect(await purgeArchivedPrompts(owner, прошлое)).toBe(0);
  });

  it('счётчик архива совпадает с содержимым архива', async () => {
    expect(await countArchivedPrompts(owner)).toBe(0);
    const один = await createPrompt(owner, { project: 'Карман', body: 'Один' });
    await createPrompt(owner, { project: 'Карман', body: 'Два' });
    await setPromptArchived(owner, один.id, true);
    expect(await countArchivedPrompts(owner)).toBe(1);
  });

  it('живой аккаунт владельца для машинного канала — активный суперпользователь', async () => {
    expect(await resolveOwnerAccountId()).toBe(owner.id);
  });
});

/**
 * Реестр разделов (миграция 0028): раздел — имя из реестра, а не «разные
 * значения project среди промтов». Иначе нельзя завести раздел заранее и нельзя
 * показать пустой.
 */
describe('реестр разделов библиотеки', () => {
  it('запись промта заводит раздел, даже если его не было', async () => {
    await createPrompt(owner, { project: 'MatricaRMZ', body: 'Текст' });
    const разделы = await listPromptSections(owner, { archived: false });
    expect(разделы).toEqual([{ name: 'MatricaRMZ', count: 1 }]);
  });

  it('раздел без промтов виден и считает ноль', async () => {
    await syncPromptProjects(owner, ['MatricaRMZ', 'KARMAN']);
    const разделы = await listPromptSections(owner, { archived: false });
    expect(разделы).toEqual([
      { name: 'KARMAN', count: 0 },
      { name: 'MatricaRMZ', count: 0 },
    ]);
  });

  it('синхронизация только добавляет: чужие разделы не пропадают', async () => {
    await createPrompt(owner, { project: 'Свой раздел', body: 'Текст' });
    await syncPromptProjects(owner, ['MatricaRMZ']);
    const разделы = await listPromptSections(owner, { archived: false });
    expect(разделы.map((s) => s.name)).toContain('Свой раздел');
    expect(разделы.map((s) => s.name)).toContain('MatricaRMZ');
  });

  it('синхронизация идемпотентна и чистит пустые имена', async () => {
    expect(await syncPromptProjects(owner, ['KARMAN', 'KARMAN', '  ', ''])).toBe(1);
    expect(await syncPromptProjects(owner, ['KARMAN'])).toBe(0);
    expect((await listPromptSections(owner, { archived: false })).map((s) => s.name)).toEqual([
      'KARMAN',
    ]);
  });

  it('счётчик раздела считает промты выбранного состояния', async () => {
    const живой = await createPrompt(owner, { project: 'KARMAN', body: 'Живой' });
    const вАрхив = await createPrompt(owner, { project: 'KARMAN', body: 'В архиве' });
    await setPromptArchived(owner, вАрхив.id, true);

    const живые = await listPromptSections(owner, { archived: false });
    expect(живые).toEqual([{ name: 'KARMAN', count: 1 }]);
    const архив = await listPromptSections(owner, { archived: true });
    expect(архив).toEqual([{ name: 'KARMAN', count: 1 }]);

    // В живых — тот, что не архивировали; в архиве — тот, что архивировали.
    const живыеПромты = await listPrompts(owner, { archived: false });
    expect(живыеПромты.map((p) => p.id)).toEqual([живой.id]);
    const архивные = await listPrompts(owner, { archived: true });
    expect(архивные.map((p) => p.id)).toEqual([вАрхив.id]);
  });

  it('переименование раздела тянет за собой его промты', async () => {
    await createPrompt(owner, { project: 'МАТРИЦА РМЗ', body: 'Текст' });
    expect(await renamePromptProject(owner, 'МАТРИЦА РМЗ', 'MatricaRMZ')).toBe(true);
    const разделы = await listPromptSections(owner, { archived: false });
    expect(разделы).toEqual([{ name: 'MatricaRMZ', count: 1 }]);
    const промты = await listPrompts(owner, { archived: false });
    expect(промты[0]!.project).toBe('MatricaRMZ');
  });

  it('переименование в существующий раздел сливает их', async () => {
    await createPrompt(owner, { project: 'МАТРИЦА РМЗ', body: 'Первое' });
    await createPrompt(owner, { project: 'MatricaRMZ', body: 'Второе' });
    expect(await renamePromptProject(owner, 'МАТРИЦА РМЗ', 'MatricaRMZ')).toBe(true);
    const разделы = await listPromptSections(owner, { archived: false });
    expect(разделы).toEqual([{ name: 'MatricaRMZ', count: 2 }]);
  });

  it('чужой раздел не переименовать', async () => {
    await createPrompt(other, { project: 'Их раздел', body: 'Текст' });
    expect(await renamePromptProject(owner, 'Их раздел', 'Мой')).toBe(false);
    expect((await listPromptSections(owner, { archived: false }))).toEqual([]);
  });
});
