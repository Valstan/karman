/**
 * Разрешение выданных доступов (grant) при чтении комнатой-получателем.
 *
 * Чистое ядро без БД: решает, какие grant'ы реально применяются к набору
 * собственных ключей комнаты. Инварианты (мандат brain 2026-07-26):
 *   1. Собственный секрет комнаты ВСЕГДА выигрывает у grant'а — чужая выдача не
 *      может молча подменить свой ключ. Заслонённый grant просто не применяется.
 *   2. Два действующих grant'а на одно имя невозможны (partial unique в БД);
 *      если такое всё же пришло — побеждает более ранний (по id), результат
 *      детерминирован и не зависит от порядка выборки.
 */

export type GrantAlias = {
  id: number;
  sourceProjectId: number;
  sourceKey: string;
  aliasKey: string;
};

export type ResolvedGrants = {
  /** Grant'ы, значения которых нужно подмешать в ответ. */
  applied: GrantAlias[];
  /** Grant'ы, заслонённые собственным ключом комнаты (диагностика/аудит). */
  shadowed: GrantAlias[];
};

/** Делит grant'ы на применяемые и заслонённые собственными ключами комнаты. */
export function resolveGrants(ownKeys: Iterable<string>, grants: GrantAlias[]): ResolvedGrants {
  const own = new Set(ownKeys);
  const applied: GrantAlias[] = [];
  const shadowed: GrantAlias[] = [];
  const taken = new Set<string>();

  for (const g of [...grants].sort((a, b) => a.id - b.id)) {
    if (own.has(g.aliasKey)) {
      shadowed.push(g);
      continue;
    }
    // Дубль по имени среди действующих grant'ов: первый занял — остальные заслонены.
    if (taken.has(g.aliasKey)) {
      shadowed.push(g);
      continue;
    }
    taken.add(g.aliasKey);
    applied.push(g);
  }

  return { applied, shadowed };
}
