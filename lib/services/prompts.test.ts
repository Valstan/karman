import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb, type TestDb } from '@/lib/db/test-db';
import {
  countArchivedPrompts,
  createPrompt,
  deletePrompt,
  listPrompts,
  purgeArchivedPrompts,
  setPromptArchived,
  summarizePromptProjects,
} from '@/lib/services/prompts';

/**
 * Библиотека промтов: инварианты, ради которых и делалась (заказ владельца
 * 2026-11-06).
 *
 * 1. Разделы — по проектам: промт попадает в свой проект, сводка считает их.
 * 2. Архив — НЕ удаление: строка остаётся, у неё появляется дата архивации,
 *    и вернуть её можно одной кнопкой.
 * 3. Очистка архива трогает ТОЛЬКО архивное: живые промты не должны пропасть
 *    от «очистить архив» — это ровно тот класс ошибки, из-за которого у
 *    владельца пропала бы работа.
 * 4. Тело промта нормализуется при записи (форма), а смысл не трогается.
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

describe('библиотека промтов', () => {
  it('новый промт попадает в свой проект и виден в живых', async () => {
    await createPrompt({ project: 'Карман', body: 'Напиши ТЗ для кассы' });
    const живые = await listPrompts({ archived: false });
    expect(живые).toHaveLength(1);
    expect(живые[0]!.project).toBe('Карман');
    expect(живые[0]!.archivedAt).toBeNull();
    expect(живые[0]!.source).toBe('manual');
  });

  it('заголовок без явного — первая строка промта', async () => {
    const создан = await createPrompt({ project: 'Карман', body: 'Проверь чеки\nи сверь' });
    expect(создан.title).toBe('Проверь чеки');
  });

  it('текст нормализуется при записи: CRLF и висячие пробелы уходят', async () => {
    const создан = await createPrompt({ project: 'Карман', body: 'Первый\r\n\r\n\r\nВторой  ' });
    expect(создан.body).toBe('Первый\n\nВторой');
  });

  it('промт от Мозга помечается источником brain', async () => {
    const создан = await createPrompt({ project: 'Карман', body: 'Текст' }, 'brain');
    expect(создан.source).toBe('brain');
  });

  it('разделы считаются по проектам', async () => {
    await createPrompt({ project: 'Карман', body: 'Один' });
    await createPrompt({ project: 'Карман', body: 'Два' });
    await createPrompt({ project: 'Setka', body: 'Три' });
    const сводка = await summarizePromptProjects();
    // Порядок разделов — по кодам символов в нижнем регистре: латиница встаёт
    // перед кириллицей ('s' < 'к'), поэтому Setka выше Кармана.
    expect(сводка).toEqual([
      { project: 'Setka', count: 1 },
      { project: 'Карман', count: 2 },
    ]);
  });

  it('архив убирает промт из живых, но не удаляет его', async () => {
    const создан = await createPrompt({ project: 'Карман', body: 'Текст' });
    expect(await setPromptArchived(создан.id, true)).toBe(true);

    expect(await listPrompts({ archived: false })).toHaveLength(0);
    const архив = await listPrompts({ archived: true });
    expect(архив).toHaveLength(1);
    expect(архив[0]!.archivedAt).not.toBeNull();
    expect(архив[0]!.body).toBe('Текст');
  });

  it('архивный промт возвращается в живые', async () => {
    const создан = await createPrompt({ project: 'Карман', body: 'Текст' });
    await setPromptArchived(создан.id, true);
    expect(await setPromptArchived(создан.id, false)).toBe(true);
    expect(await listPrompts({ archived: false })).toHaveLength(1);
    expect(await listPrompts({ archived: true })).toHaveLength(0);
  });

  it('несуществующий промт не архивируется и не удаляется', async () => {
    expect(await setPromptArchived(999_999, true)).toBe(false);
    expect(await deletePrompt(999_999)).toBe(false);
  });

  it('удаление из архива убирает строку насовсем', async () => {
    const создан = await createPrompt({ project: 'Карман', body: 'Текст' });
    await setPromptArchived(создан.id, true);
    expect(await deletePrompt(создан.id)).toBe(true);
    expect(await listPrompts({ archived: true })).toHaveLength(0);
  });

  it('очистка архива не трогает живые промты', async () => {
    const живой = await createPrompt({ project: 'Карман', body: 'Живой' });
    const вАрхиве = await createPrompt({ project: 'Карман', body: 'В архиве' });
    await setPromptArchived(вАрхиве.id, true);

    expect(await purgeArchivedPrompts()).toBe(1);
    expect(await countArchivedPrompts()).toBe(0);
    const осталось = await listPrompts({ archived: false });
    expect(осталось).toHaveLength(1);
    expect(осталось[0]!.id).toBe(живой.id);
  });

  it('очистка по дате трогает только то, что старше даты', async () => {
    const старый = await createPrompt({ project: 'Карман', body: 'Старый' });
    const свежий = await createPrompt({ project: 'Карман', body: 'Свежий' });
    await setPromptArchived(старый.id, true);
    await setPromptArchived(свежий.id, true);

    // Дата «завтра» — оба архивных старше неё, «вчера» — оба моложе.
    const будущее = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const прошлое = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(await purgeArchivedPrompts(будущее)).toBe(2);
    expect(await purgeArchivedPrompts(прошлое)).toBe(0);
  });

  it('счётчик архива совпадает с содержимым архива', async () => {
    expect(await countArchivedPrompts()).toBe(0);
    const один = await createPrompt({ project: 'Карман', body: 'Один' });
    await createPrompt({ project: 'Карман', body: 'Два' });
    await setPromptArchived(один.id, true);
    expect(await countArchivedPrompts()).toBe(1);
  });
});
