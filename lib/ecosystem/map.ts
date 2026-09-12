import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * Карта экосистемы — «какой проект и сайт крутится на каком боксе».
 *
 * Данные — ТОЛЬКО от Мозга (письмо 2026-09-11, `a-map-of-the-ecosystem-page…`):
 * приложение их не проверяет и не дополняет, а лишь показывает. Обновления
 * приходят письмами примерно раз в месяц; расхождение с реальностью — письмо Мозгу.
 *
 * Почему файл на боксе, а не статика в репозитории: содержимое — FQDN боксов,
 * порты, состав жильцов, то есть ровно то, что D-038 запрещает класть в
 * отслеживаемые файлы публичного репозитория. Поэтому в git живёт только
 * формат и рендер, а сам JSON лежит вне репозитория, путь — в env
 * `ECOSYSTEM_MAP_FILE`. Формат и способ обновления — `docs/ecosystem-map.md`.
 */

const rowSchema = z.object({
  project: z.string().min(1),
  site: z.string().default(''),
  port: z.string().default(''),
  note: z.string().default(''),
});

const groupSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().default(''),
  rows: z.array(rowSchema),
});

export const ecosystemMapSchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'asOf: ожидается ГГГГ-ММ-ДД'),
  source: z.string().default(''),
  groups: z.array(groupSchema).min(1),
  archive: z.string().default(''),
});

export type EcosystemMap = z.infer<typeof ecosystemMapSchema>;

export type EcosystemMapResult =
  | { status: 'ok'; map: EcosystemMap }
  | { status: 'unconfigured' }
  | { status: 'error'; message: string };

export function parseEcosystemMap(raw: string): EcosystemMapResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { status: 'error', message: `JSON не разбирается: ${(e as Error).message}` };
  }
  const parsed = ecosystemMapSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    return { status: 'error', message: `${where}${issue?.message ?? 'неверный формат'}` };
  }
  return { status: 'ok', map: parsed.data };
}

/** Читается при каждом запросе: обновление файла на боксе не требует рестарта. */
export async function loadEcosystemMap(): Promise<EcosystemMapResult> {
  const path = process.env.ECOSYSTEM_MAP_FILE;
  if (!path) {
    return { status: 'unconfigured' };
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    return { status: 'error', message: `файл не читается: ${(e as Error).message}` };
  }
  return parseEcosystemMap(raw);
}
