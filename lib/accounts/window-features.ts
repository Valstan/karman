/**
 * Геометрия всплывающего окна «Минимакса» (заказ владельца 12.11: «можно
 * всплывающее окно сразу тоже по центру экрана чтобы открывалось?»).
 *
 * Отдельный модуль, а не строчка в компоненте, — потому что тут есть
 * АРИФМЕТИКА, которую надо проверить: окно центрируется по экрану, на котором
 * открыто (а не по всему рабочему столу), и не уезжает за его левый/верхний
 * край — иначе на втором мониторе слева окно уехало бы в минус и браузер
 * показал его на основном.
 *
 * Модуль чистый (без DOM и без зависимостей) — юнит-тестируется.
 */

/** Размер окна в CSS-пикселях. Ширины хватает семи кнопок клетки в ряд. */
export const MINIMAX_WINDOW_SIZE = { width: 560, height: 680 } as const;

/** Прямоугольник экрана: начало в координатах рабочего стола. */
export type ScreenRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Строка `features` для `window.open` с окном, поставленным по центру экрана.
 *
 * Экран берётся тот, на котором открыт вызывающий код (`screenX/screenY`),
 * а не весь виртуальный стол: окно должно появиться там, где стоит курсор.
 */
export function centeredWindowFeatures(
  screen: ScreenRect,
  size: { width: number; height: number } = MINIMAX_WINDOW_SIZE,
): string {
  const left = Math.max(screen.x, Math.round(screen.x + (screen.width - size.width) / 2));
  const top = Math.max(screen.y, Math.round(screen.y + (screen.height - size.height) / 2));
  return [
    'popup=yes',
    `width=${size.width}`,
    `height=${size.height}`,
    `left=${left}`,
    `top=${top}`,
    'resizable=yes',
    'scrollbars=yes',
  ].join(',');
}
