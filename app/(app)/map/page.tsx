import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { requireUser } from '@/lib/auth/current-user';
import { loadBrainMap } from '@/lib/ecosystem/brain-map';
import { refreshMapAction } from '@/lib/actions/map';
import {
  countArchivedPrompts,
  listPromptSections,
  listPrompts,
} from '@/lib/services/prompts';
import { formatDate, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { MapMarkdown } from '@/components/map/markdown';
import { PromptsPanel } from '@/components/app/prompts-panel';

/**
 * «Карта проектов» — вкладки (Планы · Серверы · Дела владельца), содержимое которых
 * Мозг правит в своём репо, а мы читаем с GitHub и показываем (решение владельца
 * D-090, 12.09). Активная вкладка — в URL (`/map?tab=plans`), чтобы ссылку можно было
 * прислать владельцу. Страница не публичная: в тексте хосты и порты.
 *
 * ГРАНИЦА ВИДИМОСТИ (заказ владельца 2026-11-06): карта — ЛИЧНАЯ страница
 * владельца. Кнопки вкладок видны всем (разделы и кнопки — общие), а содержимое
 * (планы, серверы, ферма, дела, телефон) — только владельцу: не владелец видит
 * вместо вкладки заглушку, и файлы вкладок с GitHub для него вообще не
 * читаются. Вкладка «Промты» — отдельная, своя у каждого аккаунта.
 *
 * Вкладка «Промты» — из другой породы: её содержимое лежит в БД КАРМАНА, а не в
 * репозитории Мозга (промт надо копировать в буфер и архивировать, а писать в
 * репозиторий Мозга из приложения нечем — токен только на чтение). Поэтому она
 * открывается даже когда GitHub недоступен, и у неё свой подзаголовок и нет
 * кнопки «Обновить сейчас»: обновлять нечего.
 */
const PROMPTS_TAB = 'prompts';

export default async function MapPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[]; view?: string | string[] }>;
}) {
  const user = await requireUser();
  const isOwner = user.isSuperuser;
  const [result, params] = await Promise.all([
    // Не владелец получает только манифест: список вкладок без содержимого.
    loadBrainMap({ includeContent: isOwner }),
    searchParams,
  ]);
  const requested = typeof params.tab === 'string' ? params.tab : '';
  const view = typeof params.view === 'string' && params.view === 'archive' ? 'archive' : 'active';

  const githubTabs = result.status === 'ok' ? result.map.tabs : [];
  const tabs = [
    ...githubTabs.map((tab) => ({ slug: tab.slug, title: tab.title })),
    { slug: PROMPTS_TAB, title: 'Промты' },
  ];

  // Промты — из БД, поэтому эта ветка идёт ПЕРЕД проверками GitHub: библиотека
  // должна открываться и тогда, когда репозиторий Мозга не читается. И она
  // доступна КАЖДОМУ: у каждого аккаунта своя библиотека.
  if (requested === PROMPTS_TAB) {
    const [prompts, sections, archivedCount] = await Promise.all([
      listPrompts(user, { archived: view === 'archive' }),
      listPromptSections(user, { archived: view === 'archive' }),
      countArchivedPrompts(user),
    ]);
    return (
      <Shell
        subtitle={
          <>
            Промты раскладывает Мозг по вашим командам в чате. Здесь они копируются
            в буфер, уходят в архив или в архивную ленту — с датами.
          </>
        }
      >
        <nav className="flex flex-wrap gap-1 border-b" aria-label="Вкладки карты">
          <MapNav tabs={tabs} active={PROMPTS_TAB} />
        </nav>
        <PromptsPanel
          prompts={prompts}
          sections={sections}
          view={view}
          archivedCount={archivedCount}
        />
      </Shell>
    );
  }

  // Не владелец: кнопки вкладок на месте, содержимого нет — оно личное.
  if (!isOwner) {
    return (
      <Shell
        subtitle={
          <>
            Карта проектов — личная страница владельца. Ваши промты лежат во вкладке
            «Промты».
          </>
        }
      >
        <nav className="flex flex-wrap gap-1 border-b" aria-label="Вкладки карты">
          <MapNav tabs={tabs} active={requested || PROMPTS_TAB} />
        </nav>
        <section className="rounded-b-md rounded-tr-md border border-t-0 bg-card p-4 sm:p-6">
          <Alert>
            <AlertTitle>Этот раздел доступен только владельцу</AlertTitle>
            <AlertDescription>
              Содержимое карты — планы, серверы, ферма, дела и телефон — личные данные
              владельца, и другим аккаунтам оно не показывается. Свои промты смотрите во
              вкладке «Промты».
            </AlertDescription>
          </Alert>
        </section>
      </Shell>
    );
  }

  if (result.status === 'unconfigured') {
    return (
      <Shell>
        <nav className="flex flex-wrap gap-1 border-b" aria-label="Вкладки карты">
          <MapNav tabs={tabs} active={PROMPTS_TAB} />
        </nav>
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
        <nav className="flex flex-wrap gap-1 border-b" aria-label="Вкладки карты">
          <MapNav tabs={tabs} active={PROMPTS_TAB} />
        </nav>
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
        <MapNav tabs={tabs} active={active.slug} />
      </nav>

      <section className="rounded-b-md rounded-tr-md border border-t-0 bg-card p-4 sm:p-6">
        <MapMarkdown markdown={active.markdown} />
      </section>
    </Shell>
  );
}

/** Ряд вкладок карты. Промты — последняя: она из другой породы, чем вкладки Мозга. */
function MapNav({
  tabs,
  active,
}: {
  tabs: { slug: string; title: string }[];
  active: string;
}) {
  return (
    <>
      {tabs.map((tab) => {
        const isActive = tab.slug === active;
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
    </>
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
