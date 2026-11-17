import { NextResponse } from 'next/server';
import { after } from 'next/server';
import { checkInternalBearer } from '@/lib/telegram/config';
import { reconcileActivations } from '@/lib/services/minimax-reconcile';

// Сверка журнала активаций с панелью MiniMax — вызывается воркером по таймеру
// (Bearer-секрет). proxy.ts не трогает /api/* → защищаемся сами.
//
// ЗАЧЕМ (заказ владельца 17.11). Запись активации пишется в момент выдачи
// аккаунта, а очки потребитель забирает позже — когда его рантайм реально стартует.
// Всё это время журнал считает аккаунт израсходованным, и в отчёте очки есть, а
// потрачены не все: 17.11 в журнале стояло 111 активаций / 47 400 очков, а панель
// (источник правды) подтверждала забор только у 53 аккаунтов. У остальных 58
// аккаунтов очки были целы, а расход — фантомный.
//
// Что делает сверка (см. `lib/services/minimax-reconcile.ts`):
//   1) фантомные записи за сегодня удаляются, отметка дня снимается — аккаунты
//      возвращаются в оборот с настоящими очками;
//   2) у реально израсходованных записей клетка и очки уточняются ПО ПАНЕЛИ, чтобы
//      наша статистика предсказаний перестала расходиться с вендором.
//
// В ФОНЕ: сверка ходит по всем аккаунтам с записями за сегодня. Ответ уходит сразу,
// работа продолжается после него — иначе долгий запрос упёрся бы в таймаут прокси.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!checkInternalBearer(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  after(async () => {
    try {
      const report = await reconcileActivations(new Date());
      console.log(
        '[minimax/reconcile] день %s: строк %d, освобождено %d (%d очк.), уточнено %d (%d очк.), не тронуто %d',
        report.today,
        report.rows,
        report.released,
        report.releasedPoints,
        report.corrected,
        report.correctedPoints,
        report.skipped,
      );
    } catch (error) {
      console.error('[minimax/reconcile] ошибка сверки', error);
    }
  });

  return NextResponse.json({ started: true });
}
