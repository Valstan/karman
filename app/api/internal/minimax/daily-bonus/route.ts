import { NextResponse } from 'next/server';
import { after } from 'next/server';
import { checkInternalBearer } from '@/lib/telegram/config';
import { dailyBonusStats, sweepDailyBonus } from '@/lib/services/minimax-daily-bonus';
import { writeSweepMarker } from '@/lib/services/minimax-sweep-marker';

// Ежесуточный забор бонусов MiniMax — вызывается воркером по расписанию
// (05:00 МСК, Bearer-секрет). proxy.ts не трогает /api/* → защищаемся сами.
//
// ЗАЧЕМ (заказ владельца 18.11). «Каждые сутки пройтись по всем аккаунтам и
// активировать на них бонусы, записывать у себя, у кого сколько очков сегодня
// активировалось, а потом в течение дня раздавать эти аккаунты по запросам, зная, по
// сколько очков отдаётся».
//
// Забор (`POST signin/claim`) очки НЕ ТРАТИТ — начисляет: сразу после забора клетка
// имеет status 3 (забрано), но points прежние (400/1000). Позже потребитель заберёт те
// же очки повторным claim (claim_result = 2) и потратит их работой. Побочная выгода:
// серия дней подряд у аккаунта не рвётся — клетка сдвигается у всех, даже если аккаунт
// никто не взял.
//
// В ФОНЕ: обход ходит по всем аккаунтам и дёргает вендора — ответ уходит сразу,
// работа продолжается после него, иначе долгий запрос упёрся бы в таймаут прокси.
//
// Тело запроса (всё необязательно):
//   { "limit": 10 } — забрать только у первых N аккаунтов (проба);
//   { "userId": 1 } — только аккаунты этого владельца.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!checkInternalBearer(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    limit?: number;
    userId?: number;
  };

  after(async () => {
    try {
      const report = await sweepDailyBonus({
        limit: typeof body.limit === 'number' ? body.limit : undefined,
        userId: typeof body.userId === 'number' ? body.userId : undefined,
      });
      const stats = await dailyBonusStats(report.date);
      console.log(
        '[minimax/daily-bonus] %s: аккаунтов %d, забрали %d, уже было %d, пропущено %d, ошибок %d, очков в банке %d; отдано %d (%d очк.), потрачено %d, осталось %d, вернул сторож %d',
        report.date,
        report.accounts,
        report.claimed,
        report.already,
        report.skipped,
        report.failed,
        report.points,
        stats.handed,
        stats.handedPoints,
        stats.spentPoints,
        stats.leftPoints,
        stats.returned,
      );
      // МАРКЕР — ПО ФАКТУ ЗАВЕРШЕНИЯ (и только если ошибок нет). Раньше его писал воркер
      // сразу по ответу роута, а ответ уходит мгновенно: обход, который начался и умер
      // (деплой убил процесс), считался сделанным — и сутки терялись: у части аккаунтов не
      // было строки леджера, клетка вендора не сдвигалась, серия дней рвалась.
      //
      // Теперь маркер пишет приложение, когда обход реально отработал. Если ошибки есть —
      // маркера нет: воркер (раз в 30 минут) начнёт обход заново, и неудавшие аккаунты
      // получат вторую попытку (забор идемпотентен, лишних очков не начислится).
      if (report.failed === 0) {
        writeSweepMarker(report.date);
      } else {
        console.error(
          '[minimax/daily-bonus] %s: ошибок %d — маркер не записан, обход повторится',
          report.date,
          report.failed,
        );
      }
    } catch (error) {
      console.error('[minimax/daily-bonus] ошибка обхода', error);
    }
  });

  return NextResponse.json({ started: true });
}
