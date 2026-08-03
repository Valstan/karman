import { requireUser } from '@/lib/auth/current-user';
import { Header } from '@/components/app/header';

// Все страницы приложения зависят от сессии (cookie) — рендерим динамически.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <div className="flex min-h-screen flex-col">
      <Header username={user.username} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-6">{children}</main>
      <footer className="border-t py-4 text-center text-sm text-muted-foreground">
        <p>KARMAN — учёт кредитов</p>
        {/* Подпись автора — решение владельца 2026-08-01, единое для всей экосистемы. */}
        <p className="mt-1 text-xs">
          Сделано программистом{' '}
          <a
            href="https://xn--80adkmnnb2b.xn--80adkdyec4j.xn--p1ai/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Валентином Савиных
          </a>
        </p>
      </footer>
    </div>
  );
}
