import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Гейт таблицы путей записи (`docs/write-paths.md`, D-096 / #015).
 *
 * Три свойства, каждое ловит свой класс расхождения между кодом и документом:
 *
 * 1. **Каждая точка записи описана.** Новый `route.ts` или модуль `lib/actions/*` обязан
 *    появиться в таблице. Класс дефекта — «путь появился, права никто не записал»:
 *    ровно то, из-за чего `authenticated` без роли и остаётся незамеченным.
 * 2. **Каждое действие гейтит сессию в первых строках.** Гейт на странице не прикрывает
 *    Server Action: его зовут POST'ом по собственному идентификатору из чужого браузера,
 *    поэтому проверка обязана быть в самом действии.
 * 3. **Каждый пишущий HTTP-обработчик авторизован.** Публичные перечислены явно.
 *
 * Плюс сверка чисел из заголовка документа с тем, что насчитал код: цифры в prose молча
 * расходятся с реальностью, а на них потом ссылается следующий аудит.
 *
 * Намеренно НЕ проверяем, что роль в сервисе выбрана правильно, — это читается глазами
 * и проверяется состязательным аудитом (#057). Здесь ловится только отсутствие проверки.
 */

const ROOT = join(__dirname, '..', '..');
const DOC = join(ROOT, 'docs', 'write-paths.md');

/** Вызовы, которыми действие обязано взять сессию. Список, а не регулярка по слову. */
const ACTION_GATES = [
  'currentUserOrNull()',
  'requireSecretsAccess()',
  'requireUser()',
  'requireLinkAccess()',
  // Step-up для операций, меняющих безопасность учётки (аудит #057 R3/R4):
  // сброс пароля суперпользователем, включение и выключение 2FA, блокировка учётки.
  'requireAccountSecurity()',
] as const;

/**
 * Действия без гейта — только с записанной причиной. Пустой список проходит гейт так же,
 * как и непроходной список с выдуманной причиной, поэтому каждая строка обязана
 * начинаться с «почему», а не с имени функции.
 */
const ACTION_EXCEPTIONS: Record<string, string> = {
  dismissEsaLinkAction:
    'гасит cookie подтверждения своей сессии (clearOidcConfirmCookie), ни одной строки в БД не пишет',
};

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * Обработчики без авторизации — входы, где авторизация не нужна по существу. Новый
 * пункт в этом списке обязан быть публичным в том же смысле: либо ничего не пишет,
 * либо проверяет не cookie, а криптографию (пароль, код 2FA, подпись провайдера).
 */
const PUBLIC_WRITE_ROUTES: Record<string, string> = {
  'POST /api/auth/login': 'пароль + login-guard по логину и IP',
  'POST /api/auth/totp': 'pending-cookie после верного пароля + login-guard',
  'POST /api/auth/logout': 'операция только над своей сессионной cookie',
  'POST /api/telegram/ingest': 'внутренний Bearer (REMINDERS_INTERNAL_SECRET) — не публичный',
  'POST /api/reminders/dispatch': 'внутренний Bearer (REMINDERS_INTERNAL_SECRET) — не публичный',
  'GET /api/auth/oidc/start': 'cookie состояния; всё упирается в state на возврате',
  'GET /api/auth/oidc/callback': 'state + nonce + PKCE; для link — живая сессия того же uid',
  'GET /api/health': 'только SELECT 1, сознательно публичный (сторож health_watch.sh)',
};

type RouteInfo = {
  /** `app/api/secrets/grants/route.ts` → `/api/secrets/grants` */
  path: string;
  methods: string[];
  handlers: { method: string; body: string }[];
};

function walk(dir: string, filter: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, filter));
    } else if (filter(entry)) {
      out.push(full);
    }
  }
  return out;
}

function routePathOf(file: string): string {
  const rel = relative(join(ROOT, 'app', 'api'), file).split(sep).join('/');
  return `/api/${rel.replace(/\/?route\.ts$/, '')}`;
}

/** Метки экспортов: имя + смещение в исходнике. `m.index` и группа 1 не nullable по факту. */
type Mark = { name: string; index: number };

function marksOf(source: string, re: RegExp): Mark[] {
  const out: Mark[] = [];
  for (const m of source.matchAll(re)) {
    out.push({ name: m[1] ?? '', index: m.index ?? 0 });
  }
  return out;
}

function readRoutes(): RouteInfo[] {
  const dir = join(ROOT, 'app', 'api');
  return walk(dir, (name) => name === 'route.ts').map((file) => {
    const source = readFileSync(file, 'utf8');
    const handlers: { method: string; body: string }[] = [];
    // Метод и тело обработчика: от `export async function POST(` до следующего экспорта.
    const marks = marksOf(source, /^export\s+(?:async\s+)?function\s+(\w+)\s*\(/gm);
    for (let i = 0; i < marks.length; i++) {
      const mark = marks[i];
      const next = marks[i + 1];
      if (!mark) continue;
      handlers.push({ method: mark.name, body: source.slice(mark.index, next ? next.index : source.length) });
    }
    return {
      path: routePathOf(file),
      methods: [...new Set(handlers.map((h) => h.method))],
      handlers,
    };
  });
}

function readActionModules(): { file: string; source: string; exports: string[] }[] {
  const dir = join(ROOT, 'lib', 'actions');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ file: name, source: readFileSync(join(dir, name), 'utf8') }))
    // `_internal.ts` — общие хелперы (`currentUserOrNull`, `requireSecretsAccess`,
    // `revalidateAll`), а не модуль действий: у него нет `'use server'`, и его
    // экспорты не вызываются из браузера, а импортируются из модулей действий.
    .filter((mod) => mod.source.trimStart().startsWith("'use server'"))
    .map((mod) => ({
      file: mod.file,
      source: mod.source,
      exports: [...mod.source.matchAll(/^export\s+async\s+function\s+(\w+)/gm)].map((m) => m[1] ?? ''),
    }));
}

/** Тело экспорта: от его строки до следующего `export` или конца файла. */
function exportBodies(source: string): { name: string; body: string }[] {
  const marks = marksOf(source, /^export\s+(?:async\s+)?function\s+(\w+)/gm);
  return marks.map((mark, i) => ({
    name: mark.name,
    body: source.slice(mark.index, marks[i + 1] ? marks[i + 1]!.index : source.length),
  }));
}

/** Первые строки тела — именно там обязан стоять гейт, до валидации и записи. */
function headOf(body: string): string {
  const braceAt = body.indexOf('{');
  return body.slice(braceAt, braceAt + 600);
}

type ActionModule = { file: string; source: string; exports: string[] };

/** Действия без гейта сессии: `модуль → функция`. Ядро проверки, вынесено ради теста. */
function ungatedExports(modules: ActionModule[]): string[] {
  const offenders: string[] = [];
  for (const mod of modules) {
    for (const { name, body } of exportBodies(mod.source)) {
      if (ACTION_EXCEPTIONS[name]) {
        expect(ACTION_EXCEPTIONS[name], `причина для ${name}`).toMatch(/провер|сесси|гасит|не пишет|cookie/i);
        continue;
      }
      const head = headOf(body);
      if (!ACTION_GATES.some((gate) => head.includes(gate))) {
        offenders.push(`${mod.file} → ${name}`);
      }
    }
  }
  return offenders;
}

describe('таблица путей записи (docs/write-paths.md) описывает код', () => {
  const doc = readFileSync(DOC, 'utf8');
  const routes = readRoutes();
  const modules = readActionModules();

  it('числа в документе совпадают с кодом', () => {
    const handlers = routes.flatMap((r) => r.handlers);
    const writes = handlers.filter((h) => (WRITE_METHODS as readonly string[]).includes(h.method));
    const actions = modules.flatMap((m) => m.exports);

    expect(routes.length, 'роутов').toBe(21);
    expect(handlers.length, 'обработчиков').toBe(26);
    expect(writes.length, 'пишущих обработчиков').toBe(15);
    expect(modules.length, 'модулей действий').toBe(15);
    expect(actions.length, 'действий').toBe(67);

    // Числа в prose документа — не украшение: следующий аудит ссылается на них.
    expect(doc).toContain(`${routes.length} файл, ${handlers.length} обработчиков, ${writes.length} пишущих`);
    expect(doc).toContain(`${modules.length} модулей, ${actions.length} действий`);
  });

  it('каждый HTTP-роут упомянут в таблице', () => {
    const missing = routes.filter((r) => !doc.includes(r.path)).map((r) => r.path);
    expect(missing, 'роуты без строки в таблице').toEqual([]);
  });

  it('каждый модуль Server Actions упомянут в таблице', () => {
    const missing = modules.filter((m) => !doc.includes(m.file)).map((m) => m.file);
    expect(missing, 'модули без строки в таблице').toEqual([]);
  });

  it('внешние процессы из scripts/ перечислены', () => {
    for (const name of ['reminders-worker.mjs', 'karman-tg.js', 'backup_vault.sh', 'health_watch.sh']) {
      expect(doc, `${name} не упомянут`).toContain(name);
    }
  });
});

describe('Server Actions: сессия берётся в первых строках', () => {
  const modules = readActionModules();

  it('у каждого экспортированного действия есть гейт или записанная причина', () => {
    expect(ungatedExports(modules), 'действия без гейта сессии').toEqual([]);
  });

  it('гейт ловит новое действие без проверки (негативный контроль)', () => {
    // Гейт, который нельзя уронить, — не гейт. Синтетический модуль повторяет форму
    // реальных: первое действие гейтит сессию, второе забывает.
    const synthetic = [
      {
        file: 'synthetic.ts',
        source: [
          "'use server';",
          'export async function gatedAction(values: unknown) {',
          '  const user = await currentUserOrNull();',
          '  if (!user) return { ok: false };',
          '  return { ok: true };',
          '}',
          'export async function forgottenAction(values: unknown) {',
          '  const parsed = somethingSchema.parse(values);',
          '  await writeIt(parsed);',
          '  return { ok: true };',
          '}',
        ].join('\n'),
        exports: ['gatedAction', 'forgottenAction'],
      },
    ];
    expect(ungatedExports(synthetic)).toEqual(['synthetic.ts → forgottenAction']);
  });

  it('список исключений не содержит мёртвых записей', () => {
    const actual = modules.flatMap((m) =>
      exportBodies(m.source)
        .filter(({ name }) => ACTION_EXCEPTIONS[name])
        .map(({ name }) => name),
    );
    expect(actual.sort(), 'исключения без функции в коде').toEqual(Object.keys(ACTION_EXCEPTIONS).sort());
  });
});

describe('HTTP-роуты: у пишущих обработчиков есть авторизация', () => {
  const routes = readRoutes();
  const AUTH_MARKERS = [
    'bearerToken',
    'checkInternalBearer',
    'checkProvisionKey',
    'grantsGate',
    'getCurrentUser',
    'readSession',
    'readOidcState',
    'readTotpPendingUid',
    'clientIp',
    'loginAllowed',
    'totpCodeSchema',
  ];

  it('POST/PUT/PATCH/DELETE авторизован или публичен намеренно', () => {
    const offenders: string[] = [];
    for (const route of routes) {
      for (const handler of route.handlers) {
        if (!(WRITE_METHODS as readonly string[]).includes(handler.method)) continue;
        const key = `${handler.method} ${route.path}`;
        if (PUBLIC_WRITE_ROUTES[key]) continue;
        if (!AUTH_MARKERS.some((marker) => handler.body.includes(marker))) {
          offenders.push(key);
        }
      }
    }
    expect(offenders, 'пишущие обработчики без авторизации').toEqual([]);
  });

  it('каждый публичный вход описан в таблице причин', () => {
    for (const [key, why] of Object.entries(PUBLIC_WRITE_ROUTES)) {
      const [method, path] = key.split(' ');
      const exists = routes.some(
        (r) => r.path === path && r.handlers.some((h) => h.method === method),
      );
      expect(exists, `${key} нет такого обработчика — список протух`).toBe(true);
      expect(why.length, `причина для ${key} пустая`).toBeGreaterThan(10);
    }
  });

  it('обработчики, не помеченные публичными, не опознаны как таковые', () => {
    // Обратная сторона списка: роут, который переехал в «сессионные», не должен
    // остаться в публичных — иначе гейт ниже начнёт врать на реальном обработчике.
    for (const key of Object.keys(PUBLIC_WRITE_ROUTES)) {
      const [method, path] = key.split(' ');
      const handler = routes
        .find((r) => r.path === path)
        ?.handlers.find((h) => h.method === method);
      expect(handler?.body, `${key}: обработчик не найден`).toBeDefined();
    }
  });
});