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

/** Аккаунт в рейтинге: сколько раз активировался и сколько токенов унёс. */
export type AccountRatingRow = {
  id: number;
  title: string;
  email: string;
  /** Сколько сессий активации у аккаунта. */
  activations: number;
  /** Сколько очков на них ушло суммарно. */
  tokens: number;
};

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

/**
 * Рейтинг аккаунтов: кто активировался чаще всего, а сверху — сколько на них
 * ушло токенов. Порядок: активации, потом токены, потом почта (чтобы список был
 * стабильным между прогонами).
 */
export function rankAccounts(rows: AccountRatingRow[], limit: number): AccountRatingRow[] {
  return [...rows]
    .sort(
      (a, b) =>
        b.activations - a.activations ||
        b.tokens - a.tokens ||
        a.email.localeCompare(b.email) ||
        a.id - b.id,
    )
    .slice(0, limit);
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
