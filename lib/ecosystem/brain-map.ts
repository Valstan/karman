import { z } from 'zod';

/**
 * «Карта проектов» — вкладки, содержимое которых Мозг правит напрямую в своём репо
 * (решение владельца D-090, письмо Мозга 2026-09-12). Источник правды — папка
 * `docs/map/` в `Valstan/brain_matrica` (приватный репо, ветка `main`): `tabs.json`
 * задаёт вкладки, каждой соответствует Markdown-файл. КАРМАН только читает и
 * показывает — своей копии содержимого и формы правки у него нет (иначе через
 * месяц две версии разойдутся; замечания к тексту — письмом Мозгу).
 *
 * Чтение — GitHub Contents API с read-only токеном владельца
 * (`BRAIN_MAP_GITHUB_TOKEN`, Contents: read на один репозиторий). Кэш 10 минут в
 * памяти процесса, кнопка «Обновить сейчас» сбрасывает его. Если GitHub недоступен,
 * показывается последняя удачная версия с пометкой «данные могли устареть».
 * Логи — без содержимого вкладок: там хосты и порты (D-038).
 */

export const BRAIN_MAP_CACHE_TTL_MS = 10 * 60 * 1000;

const API_BASE = 'https://api.github.com/repos/Valstan/brain_matrica/contents/docs/map';

const tabSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, 'slug: латиница, цифры, дефис'),
  title: z.string().min(1),
  file: z.string().regex(/^[A-Za-z0-9_-]+\.md$/, 'file: имя .md без каталогов'),
});

export const tabsManifestSchema = z.object({
  updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'updated: ожидается ГГГГ-ММ-ДД'),
  source: z.string().default(''),
  tabs: z.array(tabSchema).min(1),
});

export type TabsManifest = z.infer<typeof tabsManifestSchema>;

export type MapTab = {
  slug: string;
  title: string;
  /** Markdown вкладки как в репо Мозга. */
  markdown: string;
};

export type BrainMap = {
  updated: string;
  source: string;
  tabs: MapTab[];
  /** Когда эта версия была успешно прочитана с GitHub. */
  fetchedAt: Date;
};

export type BrainMapResult =
  | { status: 'ok'; map: BrainMap; stale: false }
  /** GitHub недоступен, показываем последнюю удачную версию. */
  | { status: 'ok'; map: BrainMap; stale: true; error: string }
  | { status: 'unconfigured' }
  /** Ни одной удачной версии ещё не было. */
  | { status: 'error'; message: string };

export function parseTabsManifest(
  raw: string,
): { ok: true; manifest: TabsManifest } | { ok: false; message: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, message: `tabs.json не разбирается: ${(e as Error).message}` };
  }
  const parsed = tabsManifestSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    return { ok: false, message: `tabs.json: ${where}${issue?.message ?? 'неверный формат'}` };
  }
  const slugs = new Set<string>();
  for (const tab of parsed.data.tabs) {
    if (slugs.has(tab.slug)) {
      return { ok: false, message: `tabs.json: slug «${tab.slug}» повторяется` };
    }
    slugs.add(tab.slug);
  }
  return { ok: true, manifest: parsed.data };
}

export type RawFetcher = (file: string) => Promise<string>;

/** Один raw-файл из `docs/map/` через Contents API. В ошибке — только статус и имя файла. */
export function makeGithubFetcher(token: string, fetchImpl: typeof fetch = fetch): RawFetcher {
  return async (file) => {
    const res = await fetchImpl(`${API_BASE}/${encodeURIComponent(file)}?ref=main`, {
      headers: {
        Accept: 'application/vnd.github.raw+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'karman-map',
      },
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`GitHub ответил ${res.status} на ${file}`);
    }
    return res.text();
  };
}

/** Чтение всей карты: сначала манифест, потом файлы вкладок в его порядке. */
export async function fetchBrainMap(
  fetchRaw: RawFetcher,
  now: () => Date = () => new Date(),
): Promise<BrainMap> {
  const manifestRaw = await fetchRaw('tabs.json');
  const parsed = parseTabsManifest(manifestRaw);
  if (!parsed.ok) throw new Error(parsed.message);
  const { manifest } = parsed;
  const tabs = await Promise.all(
    manifest.tabs.map(async (tab) => ({
      slug: tab.slug,
      title: tab.title,
      markdown: await fetchRaw(tab.file),
    })),
  );
  return { updated: manifest.updated, source: manifest.source, tabs, fetchedAt: now() };
}

type CacheState = {
  map: BrainMap | null;
  /** До этого момента кэш считается свежим и GitHub не трогаем. */
  freshUntil: number;
  inflight: Promise<BrainMap> | null;
};

/**
 * Кэш с «последней удачной версией». Вынесен в фабрику ради тестов; в приложении —
 * один экземпляр на процесс. Параллельные запросы делят один fetch (`inflight`),
 * чтобы обновление страницы не било по GitHub пачкой.
 */
export function createBrainMapCache(opts: {
  fetchMap: () => Promise<BrainMap>;
  now?: () => number;
  ttlMs?: number;
  log?: (msg: string) => void;
}) {
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlMs ?? BRAIN_MAP_CACHE_TTL_MS;
  const log = opts.log ?? ((msg) => console.warn(msg));
  const state: CacheState = { map: null, freshUntil: 0, inflight: null };

  function refresh(): Promise<BrainMap> {
    if (!state.inflight) {
      state.inflight = opts
        .fetchMap()
        .then((map) => {
          state.map = map;
          state.freshUntil = now() + ttl;
          return map;
        })
        .finally(() => {
          state.inflight = null;
        });
    }
    return state.inflight;
  }

  return {
    async load(force = false): Promise<BrainMapResult> {
      if (!force && state.map && now() < state.freshUntil) {
        return { status: 'ok', map: state.map, stale: false };
      }
      try {
        const map = await refresh();
        return { status: 'ok', map, stale: false };
      } catch (e) {
        const message = (e as Error).message;
        // Только факт и причина — содержимого вкладок в логе быть не должно.
        log(`[map] карта Мозга не прочитана: ${message}`);
        if (state.map) {
          // Не долбить GitHub каждым запросом при затяжном сбое: пауза в минуту.
          state.freshUntil = now() + Math.min(ttl, 60_000);
          return { status: 'ok', map: state.map, stale: true, error: message };
        }
        return { status: 'error', message };
      }
    },
  };
}

// Один кэш на процесс. В dev при HMR модуль может пересоздаться — это лишь лишний fetch.
const globalKey = Symbol.for('karman.brainMapCache');
type GlobalWithCache = typeof globalThis & {
  [globalKey]?: ReturnType<typeof createBrainMapCache>;
};

function getCache() {
  const g = globalThis as GlobalWithCache;
  if (!g[globalKey]) {
    g[globalKey] = createBrainMapCache({
      fetchMap: () => {
        const token = process.env.BRAIN_MAP_GITHUB_TOKEN;
        if (!token) throw new Error('BRAIN_MAP_GITHUB_TOKEN не задан');
        return fetchBrainMap(makeGithubFetcher(token));
      },
    });
  }
  return g[globalKey];
}

export async function loadBrainMap(opts: { force?: boolean } = {}): Promise<BrainMapResult> {
  if (!process.env.BRAIN_MAP_GITHUB_TOKEN) return { status: 'unconfigured' };
  return getCache().load(opts.force ?? false);
}
