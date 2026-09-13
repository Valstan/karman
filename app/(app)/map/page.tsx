import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { requireUser } from '@/lib/auth/current-user';
import { loadBrainMap } from '@/lib/ecosystem/brain-map';
import { refreshMapAction } from '@/lib/actions/map';
import { formatDate, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { MapMarkdown } from '@/components/map/markdown';

/**
 * «Карта проектов» — вкладки (Планы · Серверы · Дела владельца), содержимое которых
 * Мозг правит в своём репо, а мы читаем с GitHub и показываем (решение владельца
 * D-090, 12.09). Активная вкладка — в URL (`/map?tab=plans`), чтобы ссылку можно было
 * прислать владельцу. Страница не публичная: в тексте хосты и порты.
 */
export default async function MapPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  await requireUser();
  const [result, params] = await Promise.all([loadBrainMap(), searchParams]);
  const requested = typeof params.tab === 'string' ? params.tab : '';

  if (result.status === 'unconfigured') {
    return (
      <Shell>
        <Alert>
          <AlertTitle>Карта не настроена</AlertTitle>
          <AlertDescription>
            Не задан токен чтения репозитория Мозга (переменная окружения{' '}
            <code>BRAIN_MAP_GITHUB_TOKEN</code>). Как получить и куда положить —{' '}
            <code>docs/ecosystem-map.md</code>.
          </AlertDescription>
        </Alert>
      </Shell>
    );
  }

  if (result.status === 'error') {
    return (
      <Shell refreshTab="">
        <Alert variant="destructive">
          <AlertTitle>Карта не прочитана из репозитория Мозга</AlertTitle>
          <AlertDescription>{result.message}</AlertDescription>
        </Alert>
      </Shell>
    );
  }

  const { map } = result;
  const active = map.tabs.find((t) => t.slug === requested) ?? map.tabs[0]!;

  return (
    <Shell
      refreshTab={active.slug}
      subtitle={
        <>
          Данные от {formatDate(map.updated)}. Содержимое правит Мозг в своём репозитории;
          замечания к тексту — письмом ему, не правкой здесь.
        </>
      }
    >
      {result.stale && (
        <Alert>
          <AlertTitle>Данные могли устареть: {formatDateTime(map.fetchedAt.toISOString())}</AlertTitle>
          <AlertDescription>
            GitHub сейчас недоступен ({result.error}). Показана последняя удачно прочитанная
            версия.
          </AlertDescription>
        </Alert>
      )}

      <nav className="flex flex-wrap gap-1 border-b" aria-label="Вкладки карты">
        {map.tabs.map((tab) => {
          const isActive = tab.slug === active.slug;
          return (
            <Link
              key={tab.slug}
              href={`/map?tab=${tab.slug}`}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                '-mb-px rounded-t-md border border-b-0 px-4 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'border-border bg-card text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.title}
            </Link>
          );
        })}
      </nav>

      <section className="rounded-b-md rounded-tr-md border border-t-0 bg-card p-4 sm:p-6">
        <MapMarkdown markdown={active.markdown} />
      </section>
    </Shell>
  );
}

function Shell({
  children,
  subtitle,
  refreshTab,
}: {
  children: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Есть значение — показываем кнопку «Обновить сейчас» и возвращаемся на эту вкладку. */
  refreshTab?: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Карта проектов</h1>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {refreshTab !== undefined && (
          <form action={refreshMapAction}>
            <input type="hidden" name="tab" value={refreshTab} />
            <Button type="submit" variant="outline" size="sm">
              <RefreshCw className="size-4" />
              Обновить сейчас
            </Button>
          </form>
        )}
      </div>
      {children}
    </div>
  );
}
