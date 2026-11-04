'use client';

import { useEffect, useState } from 'react';

/**
 * Часы раздела: текущее время КЛИЕНТА, обновляется раз в минуту.
 *
 * `null` — до первого тика. Тогда показываем серверное значение: иначе
 * серверный HTML и первая отрисовка на клиенте разойдутся (гидрация).
 * Обратный отсчёт окна активации считается по этим часам — он тикает сам.
 */
export function useNowTick(intervalMs = 60_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => {
      clearTimeout(tick);
      clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}
