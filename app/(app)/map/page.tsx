import { requireUser } from '@/lib/auth/current-user';
import { loadEcosystemMap } from '@/lib/ecosystem/map';
import { formatDate } from '@/lib/format';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * «Карта проектов»: какой сайт на каком боксе. Решение владельца 11.09 (письмо Мозга).
 * Данные — файл вне репозитория (см. lib/ecosystem/map.ts), страница — только витрина.
 * Не публичная: хосты и порты. Доступ — как у остальных внутренних страниц (сессия).
 */
export default async function MapPage() {
  await requireUser();
  const result = await loadEcosystemMap();

  if (result.status === 'unconfigured') {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold">Карта проектов</h1>
        <Alert>
          <AlertTitle>Карта не настроена</AlertTitle>
          <AlertDescription>
            Не задан путь к файлу карты (переменная окружения <code>ECOSYSTEM_MAP_FILE</code>).
            Формат и способ обновления — <code>docs/ecosystem-map.md</code>.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (result.status === 'error') {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold">Карта проектов</h1>
        <Alert variant="destructive">
          <AlertTitle>Файл карты не читается</AlertTitle>
          <AlertDescription>{result.message}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const { map } = result;
  const dash = (s: string) => (s ? s : '—');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Карта проектов</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Данные от {formatDate(map.asOf)}
          {map.source ? ` · ${map.source}` : ''}. Источник данных — Мозг; расхождение с
          реальностью — письмо Мозгу, не правка на месте.
        </p>
      </div>

      {map.groups.map((group) => (
        <Card key={group.title}>
          <CardHeader>
            <CardTitle>{group.title}</CardTitle>
            {group.subtitle && <CardDescription>{group.subtitle}</CardDescription>}
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Проект</TableHead>
                    <TableHead>Сайт</TableHead>
                    <TableHead>Порт</TableHead>
                    <TableHead>Примечание</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-muted-foreground">
                        Пусто
                      </TableCell>
                    </TableRow>
                  ) : (
                    group.rows.map((row, i) => (
                      <TableRow key={`${row.project}-${i}`}>
                        <TableCell className="font-medium whitespace-nowrap">{row.project}</TableCell>
                        <TableCell>
                          {/^https?:\/\//.test(row.site) ? (
                            <a
                              href={row.site}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline underline-offset-2"
                            >
                              {row.site}
                            </a>
                          ) : (
                            dash(row.site)
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{dash(row.port)}</TableCell>
                        <TableCell className="text-muted-foreground">{dash(row.note)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ))}

      {map.archive && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Архив (не крутится нигде):</span>{' '}
          {map.archive}
        </p>
      )}
    </div>
  );
}
