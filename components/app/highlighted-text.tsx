import type { HighlightRange } from '@/lib/search/tiered-search';

/** Текст с подсветкой совпавших фрагментов поиска (#035). */
export function HighlightedText({
  text,
  ranges,
}: {
  text: string;
  ranges?: HighlightRange[];
}) {
  if (!ranges || ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [from, to] of ranges) {
    if (from > cursor) parts.push(text.slice(cursor, from));
    parts.push(
      <mark key={from} className="rounded-[2px] bg-amber-200/80 text-inherit dark:bg-amber-400/30">
        {text.slice(from, to)}
      </mark>,
    );
    cursor = to;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
