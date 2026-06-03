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
        KARMAN — учёт кредитов
      </footer>
    </div>
  );
}
