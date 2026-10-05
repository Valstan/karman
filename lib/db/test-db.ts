import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import * as schema from './schema';

/**
 * R1: эфемерный Postgres для тестов сервисов — pglite, in-process WASM, без
 * докера и без сети. Свежий инстанс на тест (~1 с: бут pglite + вся цепочка
 * миграций): изоляция важнее скорости, пока сюита маленькая.
 *
 * Схема поднимается ТЕМИ ЖЕ рукописными миграциями, что едут на прод
 * (`lib/db/migrations/*.sql` по алфавиту): тест ловит расхождение схемы и
 * кода тем же путём, что и прод. Единственное отличие от боевой БД — стаб
 * Django-таблиц ниже: наши миграции ссылаются на `auth_user`, которого
 * создавал Django, а не мы. Внешним ключам нужны только таблица и `id`,
 * остальные колонки — чтобы фикстуры пользователей вставлялись тем же
 * Drizzle-инсертом, что и прод-код.
 *
 * Подмена в сервисы — через `vi.mock('@/lib/db/client')` в каждом тестовом
 * файле (прод-код не тронут: все сервисы берут только `{ db }`):
 *
 * ```ts
 * const refs = vi.hoisted(() => ({ current: undefined as TestDb | undefined }));
 * vi.mock('@/lib/db/client', () => ({ get db() { return refs.current; } }));
 * beforeEach(async () => { const t = await createTestDb(); pg = t.pg; refs.current = t.db; });
 * afterEach(async () => { await pg.close(); refs.current = undefined; });
 * ```
 */
export type TestDb = PgliteDatabase<typeof schema>;

/**
 * Пустая pglite-база поднимается ровно тем путём, что dev-окружение:
 * сначала `scripts/bootstrap.sql` (Django-таблицы + сид: admin, банки,
 * категории документов — на боевой БД он НЕ выполняется, там схема от
 * Django), затем ВСЕ наши рукописные миграции по алфавиту. Тест ловит
 * расхождение схемы и кода тем же путём, что и прод.
 */
export async function createTestDb(): Promise<{ pg: PGlite; db: TestDb }> {
  const pg = new PGlite();
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  await pg.exec(readFileSync(join(root, 'scripts', 'bootstrap.sql'), 'utf8'));
  const dir = join(root, 'lib', 'db', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    try {
      await pg.exec(readFileSync(join(dir, f), 'utf8'));
    } catch (e) {
      // `bootstrap.sql` — снимок текущей схемы для разработки: колонки из
      // уже применённых миграций (напр. `session_epoch` из 0019) в нём уже
      // есть, и та же миграция падает с `already exists`. На проде этого нет
      // (миграция применяется один раз на схему без колонки). Терпим ТОЛЬКО
      // этот класс — конечная форма схемы сходится, а всё остальное роняет
      // харнесс громко, как и должно.
      const msg = String((e as Error)?.message ?? e);
      if (!/already exists/.test(msg)) throw e;
    }
  }
  const db = drizzlePglite(pg, { schema });
  return { pg, db };
}
