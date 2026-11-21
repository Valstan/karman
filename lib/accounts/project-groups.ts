/**
 * Сведение проектов журнала в ГРУППЫ — «один проект в нескольких написаниях»
 * (заказ владельца 21.11).
 *
 * ЗАЧЕМ. В журнале активаций у владельца один и тот же проект лежит несколькими
 * строками, и в статистике это выглядит как несколько проектов:
 *
 * - «Матрица РМЗ» (его ручные активации) и «MatricaRMZ» (как называет себя
 *   комната проекта) — один проект;
 * - «САРАФАН» (программирование, кириллица) и «SARAFAN»+«setka» (продсервер
 *   Сарафана, латиница) — РАЗНЫЕ проекты: по живым данным комната `setka`
 *   до заголовка писалась в журнал как «SARAFAN», а после — как «setka»
 *   (заголовок `X-MiniMax-Project`), это один и тот же продсервер;
 * - «КАРМАН», «KARMAN» и «KARMAN hotline relay» — один проект.
 *
 * Кроме того, бывают очки, которые не принадлежат ни одному проекту: комната
 * Мозга («brain») — это программирование без привязки к конкретному проекту, и
 * активации, у которых проекта нет вовсе (у владельца их оставляют удалённые
 * проекты). Владелец (21.11) распорядился: такие очки делятся ПОРОВНУ между
 * его проектами программирования, а сами «brain» и «Без проекта» в статистике
 * не показываются.
 *
 * ## Почему это вычисление, а не правка данных
 *
 * Правка строк журнала не годится: комнаты присылают заголовок проекта по
 * своему усмотрению, и «MatricaRMZ» или «SARAFAN» появятся снова (и «brain» —
 * тем более). Значит, свод должен считаться на лету, по правилам, а строки
 * журнала остаются как есть — это истина о том, кто и когда запросил аккаунт.
 *
 * ## Правила (заказ владельца 21.11)
 *
 * 1. Названия приводятся к канону (см. `canonicalProjectName`): синонимы одного
 *    проекта сливаются в одну строку.
 * 2. Продсервер Сарафана виден отдельно от программирования — «Прод САРАФАН».
 * 3. Общие очки («brain» и «без проекта») делятся поровну между проектами
 *    программирования — за каждый день отдельно, чтобы по дням картина не
 *    расходилась. Продсервер в доле не участвует: это не программирование.
 * 4. В блоке «Расход по запросам» (волны проектов) общие очки НЕ показываются:
 *    там только то, что проекты тратят на свои задачи, а расход Мозга —
 *    программирование (см. `CONSUMER_ROLES` в `lib/accounts/consumer-tiers.ts`).
 *
 * Модуль ЧИСТЫЙ: его читают и сервер (выборка из БД), и клиентские компоненты
 * статистики, поэтому здесь нет ничего, что тянет Node-модули.
 */

/** Строка журнала активаций в том виде, в котором нужна статистика. */
export type JournalUsageRow = {
  /** Московская дата ('YYYY-MM-DD'). */
  usedOn: string;
  /** id проекта журнала (null — проекта нет). */
  projectId: number | null;
  /** Название проекта журнала (null — проекта нет). */
  projectName: string | null;
  /** Сколько активаций в строке. */
  activations: number;
  /** Сколько очков в строке. */
  tokens: number;
};

/** Строка «группа × день» — то, что показывают блоки статистики. */
export type GroupDayUsage = {
  /** Название группы проекта (после сведения синонимов). */
  group: string;
  /** Московская дата ('YYYY-MM-DD'). */
  usedOn: string;
  /** Сколько активаций. */
  activations: number;
  /** Сколько очков. */
  tokens: number;
};

/** Свод по группам за всё время. */
export type GroupSummary = {
  /** Название группы проекта. */
  group: string;
  /** Сколько активаций. */
  activations: number;
  /** Сколько очков. */
  tokens: number;
};

/**
 * Группы проектов: какие строки журнала — один и тот же проект.
 *
 * Сравнение — без учёта регистра и окружающих пробелов: комнаты пишут заголовок
 * `X-MiniMax-Project` по-разному («sarafan», «SARAFAN», «setka»), и в журнале
 * это разные строки.
 */
const PROJECT_GROUPS: { name: string; members: string[] }[] = [
  // Матрица РМЗ: ручные активации владельца и комната проекта.
  { name: 'Матрица РМЗ', members: ['Матрица РМЗ', 'MatricaRMZ'] },
  // Сарафан на программирование (кириллица) — отдельно от продсервера.
  { name: 'САРАФАН', members: ['САРАФАН'] },
  // Продсервер Сарафана: комната `setka` — до заголовка «SARAFAN», после «setka».
  { name: 'Прод САРАФАН', members: ['SARAFAN', 'setka'] },
  // КАРМАН: ручные активации, комната KARMAN и релей горячей линии.
  { name: 'КАРМАН', members: ['КАРМАН', 'KARMAN', 'KARMAN hotline relay'] },
];

/** Название группы по имени строки журнала (без учёта регистра). */
const GROUP_BY_LOWER_NAME = new Map<string, string>();
for (const group of PROJECT_GROUPS) {
  for (const member of group.members) {
    GROUP_BY_LOWER_NAME.set(member.trim().toLowerCase(), group.name);
  }
}

/**
 * Продсервер Сарафана: в доле общих очков не участвует — это не программирование,
 * а работа проекта на постах ВК.
 */
export const PROD_GROUP = 'Прод САРАФАН';

/**
 * Общие очки: комната Мозга («brain») — программирование без привязки к
 * конкретному проекту, и активации, у которых проекта нет вовсе.
 */
const COMMON_PROJECT_NAMES = ['brain'];

/** Название группы для строки журнала (null — проекта нет). */
export function canonicalProjectName(name: string | null): string | null {
  if (name === null) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  return GROUP_BY_LOWER_NAME.get(trimmed.toLowerCase()) ?? trimmed;
}

/** Общие ли это очки (комната Мозга или «без проекта»)? */
export function isCommonProject(name: string | null): boolean {
  if (name === null) return true;
  const trimmed = name.trim();
  if (!trimmed) return true;
  return COMMON_PROJECT_NAMES.includes(trimmed.toLowerCase());
}

/**
 * Разделить сумму поровну на `parts` частей.
 *
 * Остаток от деления достаётся ПЕРВЫМ частям (порядок получателей — по
 * алфавиту), чтобы сумма частей совпала с исходной суммой до единицы очка.
 */
function splitEvenly(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from({ length: parts }, (_, index) => base + (index < remainder ? 1 : 0));
}

/**
 * Свести строки журнала в «группы × дни».
 *
 * - названия приводятся к канону, строки одного проекта в разных написаниях
 *   сливаются в одну группу;
 * - общие очки (`brain` и «без проекта») либо раздаются поровну между проектами
 *   программирования (`shareCommon: true`), либо не попадают в свод вовсе
 *   (`shareCommon: false` — так считается блок «Расход по запросам»).
 */
export function groupUsage(
  rows: JournalUsageRow[],
  options: { shareCommon: boolean },
): GroupDayUsage[] {
  const groups = rows.map((row) => ({
    ...row,
    group: canonicalProjectName(row.projectName),
  }));

  // Получатели доли общих очков: все группы, кроме общих и продсервера.
  const recipients = [
    ...new Set(
      groups
        .filter((row) => !isCommonProject(row.projectName) && row.group !== PROD_GROUP)
        .map((row) => row.group as string),
    ),
  ].sort((a, b) => a.localeCompare(b));

  // Общие очки — по дням: в каждый день делятся между получателями поровну.
  const commonByDay = new Map<string, { activations: number; tokens: number }>();
  for (const row of groups) {
    if (!isCommonProject(row.projectName)) continue;
    const day = commonByDay.get(row.usedOn) ?? { activations: 0, tokens: 0 };
    day.activations += row.activations;
    day.tokens += row.tokens;
    commonByDay.set(row.usedOn, day);
  }

  const byDay = new Map<string, GroupDayUsage>();
  const add = (usedOn: string, group: string, activations: number, tokens: number): void => {
    const key = `${usedOn}|${group}`;
    const current = byDay.get(key) ?? { group, usedOn, activations: 0, tokens: 0 };
    current.activations += activations;
    current.tokens += tokens;
    byDay.set(key, current);
  };

  for (const row of groups) {
    if (isCommonProject(row.projectName)) continue;
    add(row.usedOn, row.group as string, row.activations, row.tokens);
  }

  if (options.shareCommon && recipients.length > 0) {
    for (const [usedOn, common] of commonByDay) {
      const tokens = splitEvenly(common.tokens, recipients.length);
      const activations = splitEvenly(common.activations, recipients.length);
      recipients.forEach((group, index) => {
        add(usedOn, group, activations[index] ?? 0, tokens[index] ?? 0);
      });
    }
  }

  // Свежие дни сверху (как в остальных блоках статистики), внутри дня — по
  // названию, чтобы порядок не прыгал между прогонами.
  return [...byDay.values()].sort(
    (a, b) => b.usedOn.localeCompare(a.usedOn) || a.group.localeCompare(b.group),
  );
}

/**
 * Свод по группам за всё время: больше очков — выше; при равенстве — больше
 * активаций, затем по названию (чтобы порядок не прыгал между прогонами).
 */
export function summarizeGroups(rows: GroupDayUsage[]): GroupSummary[] {
  const byGroup = new Map<string, GroupSummary>();
  for (const row of rows) {
    const current = byGroup.get(row.group) ?? { group: row.group, activations: 0, tokens: 0 };
    current.activations += row.activations;
    current.tokens += row.tokens;
    byGroup.set(row.group, current);
  }
  return [...byGroup.values()].sort(
    (a, b) =>
      b.tokens - a.tokens || b.activations - a.activations || a.group.localeCompare(b.group),
  );
}
