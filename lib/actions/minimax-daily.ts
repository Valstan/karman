'use server';

import { currentUserOrNull, type ActionResult } from './_internal';
import { after } from 'next/server';
import { OWNER_TIMEZONE, syncDailyStates } from '@/lib/services/minimax-daily';

/**
 * Сверить сутки аккаунтов с панелью MiniMax.
 *
 * **Проверка ничего не тратит:** панель читается (GET `signin/status`), очки
 * начисляются только `claim`ом. Поэтому после сверки видно, у кого очки реально
 * есть, а аккаунты с несожжённым бонусом можно смело отдавать потребителю.
 *
 * Операция тяжёлая (сотни вызовов панели, часть — с обновлением цепочки по
 * refresh), поэтому идёт в фоне: действие возвращает сразу, а страница
 * перечитывает состояние при следующем открытии.
 */
export async function syncDailyStatesAction(): Promise<
  ActionResult<{ started: boolean }>
> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  if (!user.isSuperuser) return { ok: false, error: 'Раздел доступен только владельцу' };
  // after(): сверка продолжается ПОСЛЕ ответа клиенту (Next 16). Обычный
  // «висящий промис» Next вправе оборвать на границе запроса — тогда половина
  // аккаунтов осталась бы без состояния, а владелец видел бы пустую сводку.
  after(async () => {
    try {
      // force: кнопка владельца — «сверить сейчас», то есть перечитать панель по
      // всем аккаунтам, даже по тем, чей ответ ещё свежий.
      await syncDailyStates(user.id, OWNER_TIMEZONE, new Date(), { force: true });
    } catch {
      // Сверка — вспомогательная: её сбой не должен ломать страницу.
    }
  });
  return { ok: true, data: { started: true } };
}
