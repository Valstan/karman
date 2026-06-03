import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

// connectionString берётся из DATABASE_URL. Если не задан — pg использует
// стандартные libpq-переменные (на сервере PGHOST=/var/run/postgresql, unix-socket).
// Pool ленивый: фактическое подключение происходит при первом запросе,
// поэтому импорт этого модуля безопасен на этапе `next build`.
const pool = new Pool(
  process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {},
);

export const db = drizzle(pool, { schema });
export { pool };
