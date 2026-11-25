/**
 * Пара «начитка + план» в хранилище промтов (заказ владельца 24.11).
 *
 * Раньше Мозг складывал надиктованную задачу («начитка») и план к ней ДВУМЯ
 * записями: проекту приходилось брать раздел и догадываться, какой план к
 * какому промту. По заказу владельца пара должна лежать ОДНИМ текстом, ОДНИМ
 * промтом: тело начитки, пустая строка, тело плана.
 *
 * Значит, хранилище само узнаёт план и присоединяет его к начитке. Правила
 * узнавания — детерминированные и осторожные: лучше НЕ слить (план останется
 * отдельной записью, её видно владельцу), чем приклеить план чужой задачи.
 *
 * Модуль чистый: без БД и без server-only — правила видны и тестируются как есть.
 */

/**
 * Заголовок плана: «План: …», «План (дополнение): …», «План (v2): …».
 *
 * Граница слова обязательна: «Планшетная версия…» и «Планшет: беда с
 * доступом» — это начитки владельца, а не планы.
 *
 * Границу проверяем НЕ через `\b`: в JS кириллица не входит в `\w`, и
 * «План:» не прошло бы проверку границы слова.
 */
export function isPlanTitle(title: string): boolean {
  return /^План(?![\p{L}])/u.test(title.trim());
}

/** Ссылки на записи в тексте: «запись #113», «промт #124», «(id 65)», «id 62». */
const RECORD_CITATION = /(?:#\s*(\d{1,6})|\bid\s*#?\s*(\d{1,6})\b)/giu;

/**
 * Ссылки на ПЛАН: «плану id 55», «плана id 65», «по плану 68», «к плану id 55».
 *
 * Только падежные формы (кому/чему): «план» в именительном — это «план
 * владельца 24.11.2026», а не ссылка на запись. Это сигнал продолжения: запись,
 * которая ссылается на план, продолжает ту задачу, а не начинает новую.
 */
const PLAN_CITATION = /план(?:у|а|ом|е|ы)\s+(?:id\s*)?#?\s*(\d{1,6})/giu;

/** Все id записей, процитированных в тексте. */
export function citedIds(body: string): number[] {
  const ids: number[] = [];
  for (const match of body.matchAll(RECORD_CITATION)) {
    const raw = match[1] ?? match[2];
    if (raw) ids.push(Number(raw));
  }
  return ids;
}

/** id планов, процитированных в тексте: «плану id 55» и подобные. */
export function citedPlanIds(body: string): number[] {
  const ids: number[] = [];
  for (const match of body.matchAll(PLAN_CITATION)) {
    const raw = match[1];
    if (raw) ids.push(Number(raw));
  }
  return ids;
}

/**
 * Слово для сравнения заголовков: нижний регистр, только буквы, и грубый
 * «стем» — обрезаем до пяти букв, чтобы «договора» и «договор», «планшете» и
 * «планшет» сошлись. Обрезка нужна иначе, а не выдумывается: «договор» и
 * «договора» — одно слово в разных падежах.
 */
function stem(word: string): string {
  return word.length > 5 ? word.slice(0, 5) : word;
}

/** Значимые слова заголовка: длиннее трёх букв, со стемом. */
function titleWords(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((word) => word.length > 3);
  return new Set(words.map(stem));
}

/**
 * Сколько значимых слов заголовков совпало: пара «План: колонка „Привязка“»
 * и «Колонка „Привязка“: три цифры договора…» дают 2+.
 */
export function titleOverlapWords(planTitle: string, promptTitle: string): number {
  const a = titleWords(planTitle);
  const b = titleWords(promptTitle);
  let overlap = 0;
  for (const word of a) {
    if (b.has(word)) overlap += 1;
  }
  return overlap;
}

/**
 * Дословная цитата начитки в теле плана.
 *
 * Планы Мозга любят цитировать основание: «промт владельца: „…“». Это
 * самый точный признак пары — цитата не может случайно указать на чужую задачу.
 */
export function quotedPromptId(
  planBody: string,
  candidates: { id: number; body: string }[],
  minLength = 80,
): number | null {
  const haystack = planBody.replace(/\s+/gu, ' ');
  let best: { id: number; length: number } | null = null;
  for (const candidate of candidates) {
    const needle = candidate.body.replace(/\s+/gu, ' ').trim();
    if (needle.length < minLength) continue;
    if (!haystack.includes(needle)) continue;
    if (!best || needle.length > best.length) best = { id: candidate.id, length: needle.length };
  }
  return best?.id ?? null;
}

/**
 * Слияние тел: начитка, пустая строка, план.
 *
 * Формат выбран владельцем 24.11: оба текста как есть, без правок и без
 * служебных меток — план читается подряд с начиткой.
 */
export function mergePromptBodies(base: string, addition: string): string {
  const left = base.trim();
  const right = addition.trim();
  if (!right) return left;
  if (!left) return right;
  return `${left}\n\n${right}`;
}
