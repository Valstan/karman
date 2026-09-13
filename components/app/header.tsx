'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from './theme-toggle';

const NAV = [
  { href: '/', label: 'Панель' },
  { href: '/documents', label: 'Документы' },
  { href: '/circle', label: 'Круг' },
  { href: '/credits', label: 'Кредиты' },
  { href: '/payments', label: 'Платежи' },
  { href: '/banks', label: 'Банки' },
  { href: '/reminders', label: 'Напоминания' },
  // Раздел секретов — только суперпользователю (решение владельца 2026-09-04).
  // Это ЛИШЬ витрина: настоящая защита стоит в `requireSecretsUser` и
  // `requireSecretsAccess`. Прятать пункт меню без них было бы обманом —
  // адрес /secrets набирается руками.
  { href: '/secrets', label: 'Секреты', superuserOnly: true },
  // Карта проектов (D-090): вкладки, содержимое — из репо Мозга через GitHub API.
  { href: '/map', label: 'Карта' },
  { href: '/settings', label: 'Настройки' },
] as const;

/**
 * Шапка — тёмная полоса во всю ширину (решение владельца 2026-09-12). Пункты
 * разделов — тёмные «кнопки» со светлым текстом; текущий раздел — инверсия:
 * жёлтый фон, тёмный текст, чтобы было видно, где ты.
 */
export function Header({ username, isSuperuser }: { username: string; isSuperuser: boolean }) {
  const pathname = usePathname();
  const router = useRouter();

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-20 border-b border-white/10 bg-primary text-white shadow-md">
      <div className="flex min-h-14 w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1.5 sm:px-5 md:px-8 xl:px-12">
        <Link href="/" className="text-lg font-bold tracking-tight text-accent">
          KARMAN
        </Link>
        <nav className="flex flex-1 flex-wrap items-center gap-1">
          {NAV.filter((item) => !('superuserOnly' in item) || isSuperuser).map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive(item.href) ? 'page' : undefined}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                isActive(item.href)
                  ? 'bg-accent text-accent-foreground shadow-sm'
                  : 'text-white/85 hover:bg-white/10 hover:text-accent',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-sm text-white/70 sm:inline">{username}</span>
          <ThemeToggle />
          <Button
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/10 hover:text-accent"
            onClick={logout}
            aria-label="Выйти"
          >
            <LogOut className="h-5 w-5" />
          </Button>
        </div>
      </div>
    </header>
  );
}
