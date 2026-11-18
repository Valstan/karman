import { NextResponse } from 'next/server';
import { after } from 'next/server';
import { checkInternalBearer } from '@/lib/telegram/config';
import { sweepPanelStates } from '@/lib/services/minimax-daily';

// Автосверка суток с панелью MiniMax — вызывается воркером по таймеру
// (Bearer-секрет). proxy.ts не трогает /api/* → защищаемся сами.
//
// ЗАЧЕМ. Заказ владельца 16.11: «сделать аккаунты активными, когда очки
// появятся». Очки у MiniMax появляются после ночного сброса, а час сброса точно
// не известен («может в 12 ночи, может быть в 3 ночи»). Наша эвристика ночной
// границы поэтому ошибается в обе стороны: то держит аккаунт вне оборота, когда
// очки уже есть, то отдаёт аккаунт, у которого очков ещё нет (ровно то, из-за
// чего 15.11 пятнадцать аккаунтов подряд отказали с «insufficient balance»).
//
// Панель MiniMax отвечает точно: `GET /signin/status` — ТОЛЬКО ЧТЕНИЕ, очки
// начисляются `claim`ом, поэтому сверка ничего не тратит. Раз в пятнадцать
// минут читаем её по всем аккаунтам с парой токенов — и аккаунты возвращаются в
// оборот сами, без кнопки.
//
// В ФОНЕ: сверка тяжёлая (сотни вызовов вендора). Ответ уходит сразу, работа
// продолжается после него — иначе долгий запрос упёрся бы в таймаут прокси.
// Если сверка не успела — следующий тик продолжит: протухшие состояния
// обновляются первыми, а свежие пропускаются.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!checkInternalBearer(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  after(async () => {
    try {
      const result = await sweepPanelStates(new Date(), { force: false });
      console.log(
        '[minimax/panel-sync] владельцев: %d, прочитано: %d, пропущено (свежие): %d, не спрашивали (правда в леджере): %d, очки есть: %d, ошибок: %d',
        result.owners,
        result.checked,
        result.skipped,
        result.notPolled,
        result.claimable,
        result.failed,
      );
    } catch (error) {
      console.error('[minimax/panel-sync] ошибка сверки', error);
    }
  });

  return NextResponse.json({ started: true });
}
