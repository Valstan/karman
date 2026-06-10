// Универсальный многоуровневый поиск (pool-спек #035, brain 2026-06-09).
//
// Единый shared-модуль для ВСЕХ полей поиска/фильтра проекта — одна точка
// настройки, единое поведение. Не копировать логику по компонентам.
//
// Уровни (по убыванию точности): точное совпадение → префикс строки →
// префикс слова → substring в любом месте → subsequence (символы по порядку
// с разрывами) → fuzzy (опечатка/перестановка, Дамерау-Левенштейн).
// Многотокенный запрос — AND: каждый токен должен совпасть (в любом поле),
// ранг элемента — по худшему токену. На нуле результатов — повтор с
// автокоррекцией раскладки RU↔EN.

export type MatchTier =
  | 'exact'
  | 'prefix'
  | 'word-prefix'
  | 'substring'
  | 'subsequence'
  | 'fuzzy';

const TIER_RANK: Record<MatchTier, number> = {
  exact: 0,
  prefix: 1,
  'word-prefix': 2,
  substring: 3,
  subsequence: 4,
  fuzzy: 5,
};

/** Диапазон подсветки [from, to) в индексах ИСХОДНОЙ строки поля. */
export type HighlightRange = [number, number];

export interface FieldHighlight {
  /** Индекс поля в массиве, который вернул getFields. */
  field: number;
  ranges: HighlightRange[];
}

export interface RankedMatch<T> {
  item: T;
  tier: MatchTier;
  /** true — результат «похожего» уровня (fuzzy), в UI помечать отдельно. */
  isFuzzy: boolean;
  highlights: FieldHighlight[];
}

export interface RankMatchesResult<T> {
  matches: RankedMatch<T>[];
  /** true — точных не нашлось и результаты получены после конвертации раскладки RU↔EN. */
  layoutConverted: boolean;
}

// ---------------------------------------------------------------------------
// Нормализация

/** lower + ё→е (длину строки не меняет — индексы остаются валидными). */
function normalizeChar(ch: string): string {
  const lower = ch.toLowerCase();
  return lower === 'ё' ? 'е' : lower;
}

interface NormalizedField {
  original: string;
  /** Нормализованная строка той же длины, что original. */
  norm: string;
  /** «Компактные цифры»: только цифры norm (для номеров `240-1`≡`2401`). */
  digits: string;
  /** digits[i] — позиция в original. */
  digitsMap: number[];
}

function normalizeField(original: string): NormalizedField {
  let norm = '';
  let digits = '';
  const digitsMap: number[] = [];
  for (let i = 0; i < original.length; i++) {
    const ch = normalizeChar(original.charAt(i));
    norm += ch;
    if (ch >= '0' && ch <= '9') {
      digits += ch;
      digitsMap.push(i);
    }
  }
  return { original, norm, digits, digitsMap };
}

/** Токен запроса «преимущественно цифровой» → сравниваем и по компактным цифрам. */
function isNumericToken(token: string): boolean {
  const digits = token.replace(/\D/g, '');
  return digits.length >= 2 && digits.length >= token.length - 2;
}

function normalizeQuery(query: string): string {
  return query
    .trim()
    .replace(/\s+/g, ' ')
    .split('')
    .map(normalizeChar)
    .join('');
}

// ---------------------------------------------------------------------------
// Раскладка RU↔EN

const EN_ROW = `qwertyuiop[]asdfghjkl;'zxcvbnm,.\``;
const RU_ROW = 'йцукенгшщзхъфывапролджэячсмитьбюё';

const EN_TO_RU = new Map<string, string>();
const RU_TO_EN = new Map<string, string>();
for (let i = 0; i < EN_ROW.length; i++) {
  EN_TO_RU.set(EN_ROW.charAt(i), RU_ROW.charAt(i));
  RU_TO_EN.set(RU_ROW.charAt(i), EN_ROW.charAt(i));
}

/** Конвертация раскладки: `ldbufntkm` → `двигатель`. Выбирает направление по составу строки. */
export function convertKeyboardLayout(text: string): string {
  let ruHits = 0;
  let enHits = 0;
  for (const ch of text) {
    if (RU_TO_EN.has(ch)) ruHits++;
    else if (EN_TO_RU.has(ch)) enHits++;
  }
  const map = ruHits >= enHits ? RU_TO_EN : EN_TO_RU;
  return text
    .split('')
    .map((ch) => map.get(ch) ?? ch)
    .join('');
}

// ---------------------------------------------------------------------------
// Сопоставление токена с полем

interface TokenMatch {
  tier: MatchTier;
  ranges: HighlightRange[];
}

function isWordBoundary(norm: string, index: number): boolean {
  if (index === 0) return true;
  const prev = norm.charAt(index - 1);
  return prev === ' ' || prev === '-' || prev === '/' || prev === '.' || prev === '(' || prev === '«' || prev === '"';
}

/** Subsequence: символы токена по порядку с разрывами. Возвращает позиции или null. */
function subsequencePositions(token: string, norm: string): number[] | null {
  const positions: number[] = [];
  let from = 0;
  for (const ch of token) {
    const idx = norm.indexOf(ch, from);
    if (idx === -1) return null;
    positions.push(idx);
    from = idx + 1;
  }
  return positions;
}

/** Дамерау-Левенштейн (с транспозициями), ранний выход по maxDist. */
export function damerauLevenshtein(a: string, b: string, maxDist: number): number {
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  const prevPrev: number[] = new Array(b.length + 1).fill(0);
  const prev: number[] = new Array(b.length + 1).fill(0);
  const curr: number[] = new Array(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      let val = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      if (
        i > 1 &&
        j > 1 &&
        a.charAt(i - 1) === b.charAt(j - 2) &&
        a.charAt(i - 2) === b.charAt(j - 1)
      ) {
        val = Math.min(val, (prevPrev[j - 2] ?? 0) + 1);
      }
      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist) return maxDist + 1;
    for (let j = 0; j <= b.length; j++) {
      prevPrev[j] = prev[j] ?? 0;
      prev[j] = curr[j] ?? 0;
    }
  }
  return prev[b.length] ?? maxDist + 1;
}

function fuzzyMaxDist(tokenLength: number): number {
  if (tokenLength <= 3) return 0; // короткие токены не фаззим — слишком много мусора
  if (tokenLength <= 6) return 1;
  return 2;
}

/** Лучшее совпадение токена с одним полем (или null). */
function matchTokenAgainstField(token: string, field: NormalizedField): TokenMatch | null {
  const { norm } = field;

  if (norm === token) return { tier: 'exact', ranges: [[0, token.length]] };

  const idx = norm.indexOf(token);
  if (idx === 0) return { tier: 'prefix', ranges: [[0, token.length]] };
  if (idx > 0) {
    return {
      tier: isWordBoundary(norm, idx) ? 'word-prefix' : 'substring',
      ranges: [[idx, idx + token.length]],
    };
  }

  // Номера: `2401` находит `240-1` (сравнение по компактным цифрам).
  if (isNumericToken(token)) {
    const tokenDigits = token.replace(/\D/g, '');
    const dIdx = field.digits.indexOf(tokenDigits);
    if (dIdx !== -1) {
      const from = field.digitsMap[dIdx];
      const last = field.digitsMap[dIdx + tokenDigits.length - 1];
      if (from !== undefined && last !== undefined) {
        return { tier: 'substring', ranges: [[from, last + 1]] };
      }
    }
  }

  const seq = subsequencePositions(token, norm);
  if (seq) {
    return { tier: 'subsequence', ranges: seq.map((p) => [p, p + 1] as HighlightRange) };
  }

  // Fuzzy: токен против каждого слова поля — целиком И как префикс слова
  // (опечатка в начале длинного слова: «сбре» → «Сбербанк»).
  const maxDist = fuzzyMaxDist(token.length);
  if (maxDist > 0) {
    let wordStart = 0;
    for (let i = 0; i <= norm.length; i++) {
      if (i === norm.length || norm.charAt(i) === ' ') {
        const word = norm.slice(wordStart, i);
        if (word && damerauLevenshtein(token, word, maxDist) <= maxDist) {
          return { tier: 'fuzzy', ranges: [[wordStart, i]] };
        }
        if (word.length > token.length) {
          const prefix = word.slice(0, token.length);
          if (damerauLevenshtein(token, prefix, maxDist) <= maxDist) {
            return { tier: 'fuzzy', ranges: [[wordStart, wordStart + token.length]] };
          }
        }
        wordStart = i + 1;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Публичный API

export interface SearchMatchResult {
  matched: boolean;
  tier: MatchTier | null;
  highlights: FieldHighlight[];
}

/**
 * Сопоставление запроса с одним элементом (его полями).
 * Многотокен AND: каждый токен должен найтись хотя бы в одном поле;
 * итоговый tier — худший из токенов.
 */
export function searchMatch(query: string, fields: (string | null | undefined)[]): SearchMatchResult {
  const q = normalizeQuery(query);
  if (!q) return { matched: true, tier: null, highlights: [] };

  const normFields = fields.map((f) => normalizeField(f ?? ''));
  const tokens = q.split(' ').filter(Boolean);

  let worst: MatchTier = 'exact';
  const highlightsByField = new Map<number, HighlightRange[]>();

  for (const token of tokens) {
    let best: { match: TokenMatch; field: number } | null = null;
    for (const [f, normField] of normFields.entries()) {
      const m = matchTokenAgainstField(token, normField);
      if (m && (!best || TIER_RANK[m.tier] < TIER_RANK[best.match.tier])) {
        best = { match: m, field: f };
      }
    }
    if (!best) return { matched: false, tier: null, highlights: [] };
    if (TIER_RANK[best.match.tier] > TIER_RANK[worst]) worst = best.match.tier;
    const acc = highlightsByField.get(best.field) ?? [];
    acc.push(...best.match.ranges);
    highlightsByField.set(best.field, acc);
  }

  const highlights = [...highlightsByField.entries()]
    .map(([field, ranges]) => ({ field, ranges: mergeRanges(ranges) }))
    .sort((a, b) => a.field - b.field);

  return { matched: true, tier: worst, highlights };
}

function mergeRanges(ranges: HighlightRange[]): HighlightRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: HighlightRange[] = [];
  for (const [from, to] of sorted) {
    const last = out[out.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/**
 * Поиск+ранжирование по списку. Сохраняет относительный порядок внутри яруса
 * (стабильная сортировка по точности). На нуле результатов повторяет запрос
 * с конвертацией раскладки RU↔EN.
 */
export function rankMatches<T>(
  query: string,
  items: T[],
  getFields: (item: T) => (string | null | undefined)[],
): RankMatchesResult<T> {
  const run = (q: string): RankedMatch<T>[] => {
    const out: RankedMatch<T>[] = [];
    for (const item of items) {
      const m = searchMatch(q, getFields(item));
      if (m.matched) {
        out.push({
          item,
          tier: m.tier ?? 'exact',
          isFuzzy: m.tier === 'fuzzy',
          highlights: m.highlights,
        });
      }
    }
    return out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
  };

  const q = normalizeQuery(query);
  if (!q) {
    return {
      matches: items.map((item) => ({ item, tier: 'exact', isFuzzy: false, highlights: [] })),
      layoutConverted: false,
    };
  }

  const direct = run(q);
  if (direct.length > 0) return { matches: direct, layoutConverted: false };

  const converted = convertKeyboardLayout(q);
  if (converted !== q) {
    const viaLayout = run(converted);
    if (viaLayout.length > 0) return { matches: viaLayout, layoutConverted: true };
  }

  return { matches: [], layoutConverted: false };
}
