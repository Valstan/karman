'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  CONSUMER_ROLES,
  OTHER_ROLE,
  type ConsumerTiers,
} from '@/lib/accounts/consumer-tiers';

/**
 * «Тысячные: куда ушли» — проверка и статистика приоритета класса очков (заказ
 * владельца 19.11): «проверь, что тысячные аккаунты отдаются в первую очередь на
 * программирование… сделай статистику, чтобы видеть реально, сколько тысячных
 * аккаунтов ушло на программирование проектов, а сколько утекло на продсервер
 * Сарафану».
 *
 * Правило выдачи (14.11): комната `brain` — панели программирования владельца —
 * получает тысячные первыми, комната `setka` — продсервер Сарафана — сначала
 * четырёхсотковые. Норма для продсервера — **ноль** тысячных; ненулевое число значит,
 * что приоритет нарушен.
 */
export function MinimaxThousands({ tiers }: { tiers: ConsumerTiers }) {
  const programming = tiers.byRole.find((row) => row.role === CONSUMER_ROLES.brain);
  const prodServer = tiers.byRole.find((row) => row.role === CONSUMER_ROLES.setka);
  const days = [...new Set(tiers.byDay.map((row) => row.usedOn))];

  if (tiers.byDay.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Выдач ещё не было — статистика появится после первой.
      </p>
    );
  }

  const thousandsBy = (usedOn: string, role: string) =>
    tiers.byDay.find((row) => row.usedOn === usedOn && row.role === role)?.thousands ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Правило (14.11): панели программирования (комната brain) получают тысячные первыми,
        продсервер Сарафана (комната setka) — сначала четырёхсотковые. Норма для продсервера —
        ноль тысячных.
      </p>

      <div className="text-sm">
        <span className="text-muted-foreground">За {tiers.days} суток: </span>
        программирование — {programming?.thousands ?? 0} тыс. (
        {(programming?.points ?? 0).toLocaleString('ru-RU')} очк.), продсервер Сарафана —{' '}
        <span className={prodServer && prodServer.thousands > 0 ? 'font-medium' : undefined}>
          {prodServer?.thousands ?? 0} тыс.
        </span>{' '}
        ({(prodServer?.points ?? 0).toLocaleString('ru-RU')} очк.)
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Кто брал</TableHead>
            <TableHead className="text-right">Тысячных</TableHead>
            <TableHead className="text-right">Четырёхсотковых</TableHead>
            <TableHead className="text-right">Очков</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tiers.byRole.map((row) => (
            <TableRow key={row.role}>
              <TableCell>{row.role}</TableCell>
              <TableCell className="text-right font-medium">{row.thousands}</TableCell>
              <TableCell className="text-right">{row.fours}</TableCell>
              <TableCell className="text-right">{row.points.toLocaleString('ru-RU')}</TableCell>
            </TableRow>
          ))}
          {tiers.byRole.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground">
                Пока ни одной выдачи.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>

      {days.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Сутки</TableHead>
              <TableHead className="text-right">Программирование</TableHead>
              <TableHead className="text-right">Продсервер Сарафана</TableHead>
              <TableHead className="text-right">{OTHER_ROLE}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {days.map((usedOn) => (
              <TableRow key={usedOn}>
                <TableCell>{usedOn}</TableCell>
                <TableCell className="text-right">
                  {thousandsBy(usedOn, CONSUMER_ROLES.brain!)}
                </TableCell>
                <TableCell
                  className={
                    thousandsBy(usedOn, CONSUMER_ROLES.setka!) > 0 ? 'text-right font-medium' : 'text-right'
                  }
                >
                  {thousandsBy(usedOn, CONSUMER_ROLES.setka!)}
                </TableCell>
                <TableCell className="text-right">{thousandsBy(usedOn, OTHER_ROLE)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}
