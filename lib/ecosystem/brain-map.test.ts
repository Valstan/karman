import { describe, expect, it, vi } from 'vitest';
import {
  createBrainMapCache,
  fetchBrainMap,
  fetchBrainMapManifest,
  makeGithubFetcher,
  parseTabsManifest,
  type BrainMap,
} from './brain-map';

const manifest = {
  updated: '2026-09-12',
  tabs: [
    { slug: 'plans', title: 'Планы', file: 'plans.md' },
    { slug: 'servers', title: 'Серверы', file: 'servers.md' },
  ],
};

describe('parseTabsManifest — tabs.json из репо Мозга', () => {
  it('валидный манифест: порядок вкладок сохраняется, source по умолчанию пустой', () => {
    const r = parseTabsManifest(JSON.stringify(manifest));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.tabs.map((t) => t.slug)).toEqual(['plans', 'servers']);
    expect(r.manifest.source).toBe('');
  });

  it('битый JSON — ошибка текстом, не исключение', () => {
    const r = parseTabsManifest('{ not json');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/tabs\.json не разбирается/);
  });

  it('имя файла с каталогом отвергается: в API уходит только имя внутри docs/map', () => {
    const bad = { ...manifest, tabs: [{ slug: 'x', title: 'X', file: '../secrets.md' }] };
    const r = parseTabsManifest(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/tabs\.0\.file/);
  });

  it('повтор slug отвергается: вкладка в URL должна быть однозначной', () => {
    const bad = { ...manifest, tabs: [manifest.tabs[0], manifest.tabs[0]] };
    expect(parseTabsManifest(JSON.stringify(bad)).ok).toBe(false);
  });
});

describe('fetchBrainMap — манифест, потом файлы вкладок', () => {
  it('читает файлы в порядке манифеста и отдаёт markdown как есть', async () => {
    const files: Record<string, string> = {
      'tabs.json': JSON.stringify(manifest),
      'plans.md': '# Планы\n',
      'servers.md': '# Серверы\n',
    };
    const calls: string[] = [];
    const map = await fetchBrainMap(
      async (f) => {
        calls.push(f);
        return files[f]!;
      },
      () => new Date('2026-09-13T10:00:00Z'),
    );
    expect(calls[0]).toBe('tabs.json');
    expect(map.tabs.map((t) => t.markdown)).toEqual(['# Планы\n', '# Серверы\n']);
    expect(map.updated).toBe('2026-09-12');
    expect(map.contentIncluded).toBe(true);
  });

  it('makeGithubFetcher: raw-accept, bearer, в ошибке нет тела ответа', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Accept).toBe('application/vnd.github.raw+json');
      expect(headers.Authorization).toBe('Bearer tok');
      if (String(url).includes('tabs.json')) return new Response('{}', { status: 200 });
      return new Response('secret body', { status: 404 });
    }) as unknown as typeof fetch;
    const fetchRaw = makeGithubFetcher('tok', fetchImpl);
    await expect(fetchRaw('tabs.json')).resolves.toBe('{}');
    await expect(fetchRaw('plans.md')).rejects.toThrow(/^GitHub ответил 404 на plans\.md$/);
  });
});

/**
 * Манифест без содержимого — то, что читает НЕ владелец карты (заказ владельца
 * 2026-11-06: карта проектов «только мне», кнопки вкладок видны всем).
 */
describe('fetchBrainMapManifest — список вкладок без содержимого', () => {
  it('читает только tabs.json: файлы вкладок с GitHub не тянутся', async () => {
    const calls: string[] = [];
    const map = await fetchBrainMapManifest(async (f) => {
      calls.push(f);
      if (f === 'tabs.json') return JSON.stringify(manifest);
      throw new Error(`файл вкладки не должен читаться: ${f}`);
    });
    expect(calls).toEqual(['tabs.json']);
    expect(map.tabs.map((t) => t.slug)).toEqual(['plans', 'servers']);
    expect(map.tabs.map((t) => t.title)).toEqual(['Планы', 'Серверы']);
    expect(map.contentIncluded).toBe(false);
  });

  it('содержимое вкладок пустое — чужим аккаунтам показывать нечего', async () => {
    const map = await fetchBrainMapManifest(async (f) =>
      f === 'tabs.json' ? JSON.stringify(manifest) : '# секрет\n',
    );
    expect(map.tabs.every((t) => t.markdown === '')).toBe(true);
  });

  it('битый манифест — ошибка текстом, как и у полной версии', async () => {
    await expect(
      fetchBrainMapManifest(async () => '{ not json'),
    ).rejects.toThrow(/tabs\.json не разбирается/);
  });
});

function fakeMap(updated: string): BrainMap {
  return { updated, source: '', tabs: [], fetchedAt: new Date(), contentIncluded: true };
}

describe('createBrainMapCache — 10 минут, последняя удачная версия при сбое', () => {
  it('в пределах TTL GitHub не трогается; после — перечитывается', async () => {
    let t = 0;
    const fetchMap = vi.fn(async () => fakeMap('v'));
    const cache = createBrainMapCache({ fetchMap, now: () => t, ttlMs: 1000, log: () => {} });
    await cache.load();
    t = 500;
    await cache.load();
    expect(fetchMap).toHaveBeenCalledTimes(1);
    t = 1001;
    await cache.load();
    expect(fetchMap).toHaveBeenCalledTimes(2);
  });

  it('force сбрасывает кэш («Обновить сейчас»)', async () => {
    const fetchMap = vi.fn(async () => fakeMap('v'));
    const cache = createBrainMapCache({ fetchMap, now: () => 0, log: () => {} });
    await cache.load();
    await cache.load(true);
    expect(fetchMap).toHaveBeenCalledTimes(2);
  });

  it('сбой после удачного чтения — stale с последней версией и причиной; лог без содержимого', async () => {
    let t = 0;
    let fail = false;
    const logs: string[] = [];
    const fetchMap = vi.fn(async () => {
      if (fail) throw new Error('GitHub ответил 503 на tabs.json');
      return fakeMap('old');
    });
    const cache = createBrainMapCache({
      fetchMap,
      now: () => t,
      ttlMs: 1000,
      log: (m) => logs.push(m),
    });
    await cache.load();
    fail = true;
    t = 2000;
    const r = await cache.load();
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.stale).toBe(true);
    expect(r.map.updated).toBe('old');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/503/);
    // Затяжной сбой: следующий запрос в ту же минуту не идёт в GitHub.
    await cache.load();
    expect(fetchMap).toHaveBeenCalledTimes(2);
  });

  it('сбой без единой удачной версии — error', async () => {
    const cache = createBrainMapCache({
      fetchMap: async () => {
        throw new Error('нет сети');
      },
      log: () => {},
    });
    await expect(cache.load()).resolves.toEqual({ status: 'error', message: 'нет сети' });
  });

  it('параллельные запросы делят один fetch', async () => {
    const fetchMap = vi.fn(async () => fakeMap('v'));
    const cache = createBrainMapCache({ fetchMap, now: () => 0, log: () => {} });
    await Promise.all([cache.load(), cache.load(), cache.load()]);
    expect(fetchMap).toHaveBeenCalledTimes(1);
  });
});
