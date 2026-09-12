import { requireUser } from '@/lib/auth/current-user';
import { Header } from '@/components/app/header';

// Все страницы приложения зависят от сессии (cookie) — рендерим динамически.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <div className="flex min-h-screen flex-col">
      <Header username={user.username} isSuperuser={user.isSuperuser} />
      {/* Во всю ширину экрана (решение владельца 2026-09-12); поля растут с экраном. */}
      <main className="w-full flex-1 px-3 py-5 sm:px-5 md:px-8 xl:px-12">{children}</main>
      <footer className="border-t border-white/10 py-4 text-center text-sm text-white/70">
        {/* Концепция владельца 2026-09-12: KARMAN — карман, куда складываешь всё своё. */}
        <p>KARMAN — всё своё при себе</p>
        {/* Подпись автора — решение владельца 2026-08-01, единое для всей экосистемы. */}
        <p className="mt-1 text-xs">
          Сделано программистом{' '}
          <a
            href="https://xn--80adkmnnb2b.xn--80adkdyec4j.xn--p1ai/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-accent"
          >
            Валентином Савиных
          </a>
        </p>
      </footer>
    </div>
  );
}
