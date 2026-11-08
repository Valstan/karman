'use client';

import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WEEKLY_ACTIVATION_POINTS, pointsForIndex } from '@/lib/accounts/weekly';

/**
 * Ряд из СЕМИ кнопок — выбор номера активации в неделе (заказ владельца
 * 08.11).
 *
 * Почему именно семь, а не два («400 / 1000»), как было до сих пор:
 * очки MiniMax — ежедневный чек-ин, 400 очков за день, но в 4-й и 7-й день
 * недели — 1000 (документация M Plan: «Daily check-ins earn 400 points,
 * check-ins on day 4 and day 7 award 1,000 points, a full week of check-ins earns
 * 4,000 points»). Номер активации — это номер КЛЕТКИ недели аккаунта на
 * панели MiniMax, и очки — производная от него. Значит, выбирать надо
 * НОМЕР (1..7), а очки программа проставит сама.
 *
 * Раньше программа считала номер как «число строк журнала плюс один» — из-за
 * первого же пропущенного дня счёт уезжал, и на боевых данных 08.11 почти все
 * аккаунты показывали 1000 очков (владелец и жаловался). Теперь номер
 * считается по календарю (см. `lib/accounts/weekly.ts`), а кнопки дают
 * владельцу сказать настоящий номер руками — и дальше программа считает от
 * его номера.
 *
 * Ряд горизонтальный (заказ владельца 08.11: «эти кнопочки выбираю просто в
 * ряд, ну, как в ряд, горизонтальный»), каждая кнопка подписана своим
 * номером и очками, которые за ним стоят.
 */
export function MinimaxActivationPoints({
  value,
  onChange,
  disabled = false,
  label = 'Номер активации в неделе',
}: {
  /** Выбранный номер (1..7). */
  value: number;
  /** Нажатие кнопки — номер, который назвал владелец. */
  onChange: (index: number) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium leading-none">{label}</span>
      <div className="flex flex-wrap gap-1">
        {WEEKLY_ACTIVATION_POINTS.map((points, i) => {
          const index = i + 1;
          const selected = value === index;
          return (
            <Button
              key={index}
              type="button"
              size="sm"
              variant={selected ? 'default' : 'outline'}
              disabled={disabled}
              aria-pressed={selected}
              title={`${index}-я активация в неделе — ${points} очков`}
              className="h-auto min-w-[3.25rem] flex-col gap-0 px-1.5 py-1"
              onClick={() => onChange(index)}
            >
              <span className="text-xs leading-tight">{index}-я</span>
              <span className="text-[10px] leading-tight font-normal opacity-80">
                {points}
              </span>
              {selected ? <Check className="h-3 w-3 text-emerald-400" /> : null}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

/** Очки за номер — для подписи рядом с рядом кнопок. */
export function activationPointsLabel(index: number): string {
  return `${index}-я активация — ${pointsForIndex(index)} очков`;
}
