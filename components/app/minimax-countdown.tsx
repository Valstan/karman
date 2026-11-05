'use client';

import { ACTIVATION_WINDOW_MS } from '@/lib/accounts/rotation';
import { utcToMoscowLocal } from '@/lib/reminders/time';

/**
 * Обратный отсчёт до освобождения аккаунта (заказ владельца 04.11: «сколько
 * времени осталось, чтобы примерно понимать, нужно ли создавать ещё аккаунты,
 * или просто надо маленько подождать»).
 *
 * Часы тикает вызывающий (одни на раздел), поэтому счётчик в строках не
 * расходится между собой на минуту.
 */
export function MinimaxCountdown({
  availableAt,
  remainingMs,
  now,
  className,
}: {
  /** Когда аккаунт снова свободен (ISO) или null — если не активировался. */
  availableAt: string | null;
  /** Серверное значение остатка (на момент рендера сервером). */
  remainingMs: number;
  /** Клиентские часы; null — показываем серверное значение. */
  now: number | null;
  className?: string;
}) {
  if (!availableAt) return null;
  const left = now === null ? remainingMs : Math.max(0, new Date(availableAt).getTime() - now);
  return (
    <span className={className}>
      {left <= 0 ? 'свободен' : `свободен через ${formatRemaining(left)}`}
    </span>
  );
}

/** «23 ч 12 мин» — остаток окна простоя. */
export function formatRemaining(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} мин`;
  return `${hours} ч ${minutes} мин`;
}

/**
 * «06.11 14:20» — момент освобождения по московскому времени (заказ владельца
 * 05.11: «когда он освободится, дата, сколько, через сколько часов и минут»).
 *
 * Время московское: владелец думает о днях в своих часах, а не в UTC.
 */
export function formatAvailableAt(iso: string): string {
  const local = utcToMoscowLocal(iso); // 'YYYY-MM-DDTHH:MM'
  const month = local.slice(5, 7);
  const day = local.slice(8, 10);
  return `${day}.${month} ${local.slice(11)}`;
}

/**
 * Момент освобождения после ТЕКУЩЕЙ активации: окно 24 часа от момента
 * копирования. Нужен плавающему окну, где активация происходит на глазах.
 */
export function availableAtFromNow(at: number): string {
  return new Date(at + ACTIVATION_WINDOW_MS).toISOString();
}
