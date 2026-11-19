/**
 * Статистика мультиаккаунта — ЧИСТЫЕ функции (заказ владельца 05.11).
 *
 * Что хотел владелец: чтобы по активациям было видно не только «сколько на проект»,
 * но и «сколько в день, по скольким проектам, на сколько токенов», рейтинг самых
 * часто активируемых аккаунтов и кривую активности за пару месяцев.
 *
 * Почему отдельный модуль, а не всё в сервисе: цифры считаются из строк журнала
 * `accounts_usage`, и их надо проверять без БД — здесь нет ни запросов, ни часов.
 * Сервис отдаёт готовые строки, компоненты считают по ним (свод, сортировка,
 * непрерывный ряд для графика).
 *
 * Даты — МОСКОВСКИЕ календарные метки ('YYYY-MM-DD'): журнал пишет `used_on` как
 * московскую дату сессии. Арифметика по датам здесь календарная (сдвиг на сутки
 * через Date.UTC), а не часовая: московская дата — это метка, а не инстант.
 */

/** Метрика, по которой сортируют таблицу сумм. */
export type DailyMetric = 'activations' | 'projects' | 'tokens';

/** Суммы за один московский день. */
export type DailyUsage = {
  /** Московская дата ('YYYY-MM-DD'). */
  usedOn: string;
  /** Сколько активаций (сессий) было за день. */
  activations: number;
  /** Сколько РАЗНЫХ проектов было задействовано (активации без проекта не считаются). */
  projects: number;
  /** Сколько очков начислено за день (в БД колонка называется tokens). */
  tokens: number;
};

/** Строка журнала активаций в том виде, в котором нужна статистике. */
export type UsageRecord = {
  usedOn: string;
  projectId: number | null;
  tokens: number;
};

/**
 * Чемпионат по проектам (заказ владельца 19.11): «проекты типа участвуют в
 * чемпионате по потраченным очкам. Одна игра — это одни сутки. Какой проект больше
 * остальных потратил очков в сутки — тот и выиграл: за 1 место 3 балла, за 2 — 2, за 3 —
 * 1. Таким образом турнирная таблица: кто больше набрал баллов по суткам, тот выше».
 *
 * Очки за сутки — это `tokens` из журнала активаций в сумме по проекту за московский
 * день (то же число, что в разделе «Расход по проектам»).
 */
export type ChampionshipRow = {
  projectId: number;
  projectName: string;
  /** Баллы чемпионата: 3 за первое место в сутках, 2 за второе, 1 за третье. */
  points: number;
  /** Очки, потраченные проектом суммарно (за все учтённые сутки). */
  spent: number;
  /** Сколько суток проект был в тройке. */
  topDays: number;
  /** Сколько раз проект был первым за сутки. */
  wins: number;
  /** Сколько суток проект вообще что-то тратил. */
  days: number;
};

/** Строка «проект × сутки» — вход для подсчёта чемпионата. */
export type ProjectDayPoints = {
  usedOn: string;
  projectId: number | null;
  projectName: string | null;
  /** Очки, потраченные проектом за этот день. */
  points: number;
};

/** Баллы за места в суточном заезде: первое — 3, второе — 2, третье — 1. */
export const CHAMPIONSHIP_SCORES = [3, 2, 1] as const;

/** Лидер одного дня: проект, его очки и набранный балл. */
export type ChampionshipDayLeader = {
  projectName: string;
  /** Очки, потраченные проектом за сутки. */
  points: number;
  /** Балл за место в этот день. */
  score: number;
};

/**
 * Свести строки «проект × день» в карту «день → проекты с очками» и отсортировать
 * проекты дня: больше очков — выше; при равенстве — по названию (чтобы порядок не
 * прыгал между прогонами).
 */
function groupChampionshipByDay(rows: ProjectDayPoints[]): Map<string, { id: number; name: string; points: number }[]> {
  const byDay = new Map<string, Map<number, { id: number; name: string; points: number }>>();
  for (const row of rows) {
    // Проект без проекта (активация владельца) в чемпионате не участвует, и день без
    // очков никому балла не приносит.
    if (row.projectId === null || row.points <= 0) continue;
    const day = byDay.get(row.usedOn) ?? new Map();
    const current = day.get(row.projectId) ?? {
      id: row.projectId,
      name: row.projectName ?? '—',
      points: 0,
    };
    current.points += row.points;
    day.set(row.projectId, current);
    byDay.set(row.usedOn, day);
  }
  const ranked = new Map<string, { id: number; name: string; points: number }[]>();
  for (const [usedOn, day] of byDay) {
    ranked.set(
      usedOn,
      [...day.values()].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name)),
    );
  }
  return ranked;
}

/**
 * Турнирная таблица чемпионата по проектам.
 *
 * За каждый московский день тройка лидеров по потраченным очкам получает 3, 2 и 1
 * балл; баллы по дням суммируются. Порядок таблицы: больше баллов — выше; при
 * равенстве — больше суммарно потраченных очков; затем по названию.
 */
export function buildChampionship(rows: ProjectDayPoints[]): ChampionshipRow[] {
  const ranked = groupChampionshipByDay(rows);
  const totals = new Map<number, ChampionshipRow>();

  for (const day of ranked.values()) {
    day.forEach((project, index) => {
      const row = totals.get(project.id) ?? {
        projectId: project.id,
        projectName: project.name,
        points: 0,
        spent: 0,
        topDays: 0,
        wins: 0,
        days: 0,
      };
      row.spent += project.points;
      row.days += 1;
      const score = CHAMPIONSHIP_SCORES[index];
      if (score !== undefined) {
        row.points += score;
        row.topDays += 1;
        if (index === 0) row.wins += 1;
      }
      totals.set(project.id, row);
    });
  }

  return [...totals.values()].sort(
    (a, b) =>
      b.points - a.points ||
      b.spent - a.spent ||
      a.projectName.localeCompare(b.projectName),
  );
}

/**
 * Лидеры последних учтённых суток — строка «кто выиграл вчера» над таблицей.
 * Пусто, если в журнале нет ни одной строки с очками.
 */
export function championshipLeaders(rows: ProjectDayPoints[]): {
  usedOn: string;
  leaders: ChampionshipDayLeader[];
} {
  const ranked = groupChampionshipByDay(rows);
  const days = [...ranked.keys()].sort((a, b) => (a < b ? 1 : -1));
  const usedOn = days[0];
  if (!usedOn) return { usedOn: '', leaders: [] };
  const leaders = ranked.get(usedOn)!.slice(0, CHAMPIONSHIP_SCORES.length).map((project, index) => ({
    projectName: project.name,
    points: project.points,
    score: CHAMPIONSHIP_SCORES[index]!,
  }));
  return { usedOn, leaders };
}

/**
 * Свод журнала по дням: активации, задействованные проекты, токены.
 *
 * Одна строка журнала = одна сессия активации (окно 24 ч с момента, значит за
 * московские сутки аккаунт активируется не более одного раза — см.
 * `docs/minimax.md`). Значит «активаций за день» и «сколько аккаунтов
 * активировано» — одно и то же число.
 *
 * Дни без активаций в выдаче НЕ появляются: их дорисует `fillDailySeries`.
 */
export function aggregateDailyUsage(rows: UsageRecord[]): DailyUsage[] {
  const days = new Map<string, { activations: number; tokens: number; projects: Set<number> }>();
  for (const row of rows) {
    const day = days.get(row.usedOn) ?? { activations: 0, tokens: 0, projects: new Set<number>() };
    day.activations += 1;
    day.tokens += row.tokens;
    if (row.projectId !== null) day.projects.add(row.projectId);
    days.set(row.usedOn, day);
  }
  return [...days.entries()]
    .map(([usedOn, day]) => ({
      usedOn,
      activations: day.activations,
      projects: day.projects.size,
      tokens: day.tokens,
    }))
    .sort(byDateDesc);
}

/**
 * Непрерывный ряд за `count` дней, заканчивающийся `endDate` (московская дата).
 *
 * Дни без активаций дорисовываются нулями: иначе кривая графика рвётся, и по
 * ней нельзя понять, что в какой-то день работы не было.
 */
export function fillDailySeries(days: DailyUsage[], count: number, endDate: string): DailyUsage[] {
  const byDate = new Map(days.map((day) => [day.usedOn, day]));
  const series: DailyUsage[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const usedOn = shiftDate(endDate, -offset);
    series.push(byDate.get(usedOn) ?? { usedOn, activations: 0, projects: 0, tokens: 0 });
  }
  return series;
}

/** Сортировка таблицы сумм по метрике. При равенстве — свежие дни сверху. */
export function sortDailyUsage(
  rows: DailyUsage[],
  metric: DailyMetric,
  direction: 'asc' | 'desc',
): DailyUsage[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const diff = a[metric] - b[metric];
    if (diff !== 0) return diff * sign;
    return byDateDesc(a, b);
  });
}

/** Календарный сдвиг московской даты на целые сутки. */
export function shiftDate(usedOn: string, days: number): string {
  const parts = usedOn.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error(`Некорректная московская дата: ${usedOn}`);
  }
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  const yyyy = String(shifted.getUTCFullYear());
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function byDateDesc(a: DailyUsage, b: DailyUsage): number {
  if (a.usedOn === b.usedOn) return 0;
  return a.usedOn < b.usedOn ? 1 : -1;
}

/** Проект для выпадающего списка: id и название. */
export type ProjectChoice = { id: number; name: string };

/** Сколько раз проект попал в активации (по журналу). */
export type ProjectUsageCount = {
  projectId: number | null;
  activations: number;
  tokens: number;
};

/**
 * Проекты в порядке «чаще всего используемые сверху» (заказ владельца 05.11):
 * в списке выбора проекта самые ходовые должны быть наверху — иначе каждый раз
 * приходится искать нужный глазами.
 *
 * Порядок: число активаций (как часто берут), при равенстве — токены (куда уходит
 * больше), потом название — чтобы список не прыгал между прогонами.
 *
 * Проект без единой активации уходит вниз (нули), «Без проекта» в список не
 * входит вовсе — его владелец ставит первым вручную.
 */
export function sortProjectsByUsage<T extends ProjectChoice>(
  projects: T[],
  usage: ProjectUsageCount[],
): T[] {
  const counts = new Map<number, { activations: number; tokens: number }>();
  for (const row of usage) {
    if (row.projectId === null) continue;
    counts.set(row.projectId, { activations: row.activations, tokens: row.tokens });
  }
  return [...projects].sort((a, b) => {
    const left = counts.get(a.id);
    const right = counts.get(b.id);
    const leftActivations = left?.activations ?? 0;
    const rightActivations = right?.activations ?? 0;
    if (leftActivations !== rightActivations) return rightActivations - leftActivations;
    const leftTokens = left?.tokens ?? 0;
    const rightTokens = right?.tokens ?? 0;
    if (leftTokens !== rightTokens) return rightTokens - leftTokens;
    return a.name.localeCompare(b.name);
  });
}
