'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ApiUsageDay } from '@/lib/services/accounts';

/**
 * «Расход по запросам проектов» — сколько аккаунтов MiniMax и очков ушло на волны
 * проектов (заказ владельца 14.11).
 *
 * «В статистике отдельно учитывай расход аккаунтов минимакса запросами с Сарафана —
 * это не программирование, это сам проект Сарафан тратит аккаунты на обработки постов
 * из ВК. Это надо подсчитывать отдельно от аккаунтов, которые я трачу на
 * программирование, но также по дням смотреть, чтобы в какие дни по сколько
 * аккаунтов и очков тратится на Сарафане».
 *
 * Отдельно от расхода владельца на программирование — по МЕТКЕ строки журнала
 * (`source = 'api'`), а не по названию проекта: у владельца «САРАФАН» (кириллица),
 * у комнаты «SARAFAN» (латиница) — разница в одном символе, а не различие.
 *
 * По дням — потому что владельцу нужно видеть РИТМ: в какие дни волна съела много
 * аккаунтов, а в какие — простаивала.
 */
export function MinimaxApiUsage({ days }: { days: ApiUsageDay[] }) {
  const totals = days.reduce(
    (sum, day) => ({ activations: sum.activations + day.activations, tokens: sum.tokens + day.tokens }),
    { activations: 0, tokens: 0 },
  );

  return (
    <div className="rounded-md border">
      <div className="p-4 pb-2">
        <h2 className="text-lg font-semibold">Расход по запросам проектов</h2>
        <p className="text-xs text-muted-foreground">
          Аккаунты и очки, которые ушли на волны проектов (Сарафан — обработка постов
          ВК). Это не расход владельца на программирование — тот в «Расход по
          проектам». По дням — чтобы видеть ритм волны.
        </p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>День</TableHead>
            <TableHead className="text-right">Аккаунтов</TableHead>
            <TableHead className="text-right">Очков</TableHead>
            <TableHead>Проекты</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {days.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground">
                Пока ни одного аккаунта по запросу проекта.
              </TableCell>
            </TableRow>
          ) : null}
          {days.map((day) => (
            <TableRow key={day.usedOn}>
              <TableCell className="font-mono text-xs">{day.usedOn}</TableCell>
              <TableCell className="text-right">{day.activations}</TableCell>
              <TableCell className="text-right">{day.tokens}</TableCell>
              <TableCell className="text-sm">
                {day.projects
                  .map(
                    (project) =>
                      `${project.projectName ?? 'Без проекта'} — ${project.activations} акк., ${
                        project.tokens
                      } очк.`,
                  )
                  .join('; ')}
              </TableCell>
            </TableRow>
          ))}
          {days.length === 0 ? null : (
            <TableRow>
              <TableCell className="font-medium">Всего</TableCell>
              <TableCell className="text-right font-medium">{totals.activations}</TableCell>
              <TableCell className="text-right font-medium">{totals.tokens}</TableCell>
              <TableCell />
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
