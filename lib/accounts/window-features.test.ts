import { describe, expect, it } from 'vitest';
import { MINIMAX_WINDOW_SIZE, centeredWindowFeatures } from '@/lib/accounts/window-features';

/**
 * Гейт геометрии всплывающего окна (заказ владельца 12.11: окно открывается по
 * центру экрана).
 *
 * Проверяется не «красиво», а то, что ломается иначе и молча: окно уехало бы
 * в минус на втором мониторе слева (браузер показал бы его на основном
 * экране — владелец смотрел бы не туда), а на экране меньше окна координата
 * уехала бы за его край.
 */
describe('всплывающее окно открывается по центру экрана', () => {
  it('основной экран 1920×1080: окно по центру', () => {
    const features = centeredWindowFeatures({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(features).toContain('width=560');
    expect(features).toContain('height=680');
    expect(features).toContain('left=680'); // (1920 − 560) / 2
    expect(features).toContain('top=200'); // (1080 − 680) / 2
  });

  it('второй монитор слева: окно остаётся на НЁМ, а не уезжает в минус', () => {
    const features = centeredWindowFeatures({ x: -1920, y: 0, width: 1920, height: 1080 });
    expect(features).toContain('left=-1240'); // −1920 + (1920 − 560) / 2
    expect(features).toContain('top=200');
  });

  it('экран меньше окна: левый край не уезжает за пределы экрана', () => {
    const features = centeredWindowFeatures({ x: 0, y: 0, width: 1024, height: 600 });
    expect(features).toContain('left=232'); // 0 + (1024 − 560) / 2 — окно шире экрана по высоте, но не по ширине
    expect(features).toContain('top=0'); // окно выше экрана — верх прижат к краю, а не в минус
  });

  it('размер окна задаётся явно и попадает в features', () => {
    const features = centeredWindowFeatures(
      { x: 0, y: 0, width: 1920, height: 1080 },
      { width: 300, height: 400 },
    );
    expect(features).toContain('width=300');
    expect(features).toContain('height=400');
    expect(features).toContain('left=810');
    expect(features).toContain('top=340');
  });

  it('окно остаётся открываемым и изменяемым (popup, без рамки приложения)', () => {
    const features = centeredWindowFeatures({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(features).toContain('popup=yes');
    expect(features).toContain('resizable=yes');
    expect(features).toContain('scrollbars=yes');
  });

  it('размер по умолчанию — тот, на который рассчитаны семь кнопок клетки', () => {
    expect(MINIMAX_WINDOW_SIZE.width).toBeGreaterThanOrEqual(560);
    expect(MINIMAX_WINDOW_SIZE.height).toBeGreaterThanOrEqual(680);
  });
});
