'use client';

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Человек в разделе «Документы»: ключ = holder (пусто — владелец аккаунта). */
export type PersonCard = {
  key: string;
  name: string;
  docCount: number;
  fileCount: number;
  /** URL превью для «фото»: документ вида «Фотография», иначе — скан паспорта. */
  avatarUrl: string | null;
};

function initials(name: string): string {
  const parts = name
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

/** Имя без пометки родства в скобках — для крупной подписи; родство — мелко ниже. */
function splitName(name: string): { main: string; note: string } {
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(name);
  return m ? { main: m[1]!, note: m[2]! } : { main: name, note: '' };
}

/**
 * Карточки людей (решение владельца 2026-09-12): нажал — список показывает
 * документы только этого человека; галочка в углу — берёт человека в выборку
 * для скачивания/«поделиться» вместе с другими.
 */
export function PeopleCards({
  people,
  activeKey,
  picked,
  onOpen,
  onTogglePick,
}: {
  people: PersonCard[];
  /** Ключ человека, чьи документы показаны; null — все. */
  activeKey: string | null;
  picked: Set<string>;
  onOpen: (key: string) => void;
  onTogglePick: (key: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-8">
      {people.map((person) => {
        const active = activeKey === person.key;
        const isPicked = picked.has(person.key);
        const { main, note } = splitName(person.name);
        return (
          <div
            key={person.key || '__me'}
            role="button"
            tabIndex={0}
            aria-pressed={active}
            onClick={() => onOpen(person.key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen(person.key);
              }
            }}
            className={cn(
              'relative flex cursor-pointer flex-col items-center gap-2 rounded-xl border bg-card p-3 text-center shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md',
              active ? 'border-accent ring-2 ring-accent' : 'border-border',
            )}
          >
            <label
              className={cn(
                'absolute top-2 right-2 flex size-6 items-center justify-center rounded-md border transition-colors',
                isPicked ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background',
              )}
              title="В выборку для скачивания / «поделиться»"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={isPicked}
                onChange={() => onTogglePick(person.key)}
                aria-label={`Выбрать ${person.name}`}
              />
              {isPicked && <Check className="size-4" />}
            </label>
            <div className="size-20 overflow-hidden rounded-full border-2 border-accent/60 bg-muted">
              {person.avatarUrl ? (
                // Приватный файл за авторизованным роутом — обычный <img>, не next/image.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={person.avatarUrl} alt="" className="size-full object-cover" loading="lazy" />
              ) : (
                <div className="flex size-full items-center justify-center text-xl font-semibold text-primary">
                  {initials(person.name) || '?'}
                </div>
              )}
            </div>
            <div className="min-w-0 w-full">
              <div className="line-clamp-2 text-sm leading-tight font-medium break-words">{main}</div>
              {note && <div className="text-xs text-muted-foreground">{note}</div>}
              <div className="mt-1 text-xs text-muted-foreground">
                {person.docCount} док.{person.fileCount > 0 ? ` · ${person.fileCount} скан.` : ''}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
