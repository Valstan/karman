'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

/**
 * Коды из `?esa=…` переводятся в человеческий текст здесь, а не в роуте:
 * наружу из роутов уходит только маркер, чтобы причина отказа (она же подсказка
 * для перебора) жила в аудите, а не в адресной строке пользователя.
 */
const ESA_NOTICES: Record<string, string> = {
  off: 'Вход через ЕСА сейчас не настроен. Войдите логином и паролем.',
  unavailable: 'ЕСА временно недоступна. Войдите логином и паролем.',
  denied: 'Вход через ЕСА отменён.',
  expired: 'Попытка входа устарела — начните заново.',
  bad_state: 'Не удалось подтвердить возврат из ЕСА. Начните вход заново.',
  verify_failed: 'ЕСА не подтвердила вход. Попробуйте ещё раз.',
  inactive: 'Учётная запись отключена. Обратитесь к владельцу.',
  ambiguous: 'На эту почту заведено несколько учётных записей — войдите логином и паролем.',
  not_invited:
    'ЕСА вас подтвердила, но учётной записи в КАРМАНе нет. Её заводит владелец — попросите пригласить вас.',
};

export type LoginFormProps = {
  /** ЕСА настроена целиком (issuer + client_id + secret + redirect_uri). */
  esaEnabled: boolean;
  /** Пользователь уже прошёл первый фактор и вернулся за кодом. */
  totpPending: boolean;
  /** Маркер из ?esa=… — что именно не сложилось на стороне единого входа. */
  esaNotice: string | null;
};

export function LoginForm({ esaEnabled, totpPending, esaNotice }: LoginFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  // Засов от повторной отправки. Одного `disabled={loading}` мало: setState
  // применяется к следующему рендеру, и три нажатия Enter подряд успевают
  // выстрелить тремя POST'ами до того, как кнопка станет неактивной. Цена
  // ровно такая: 2026-08-25 у владельца так сгорели все 10 попыток за 29 с
  // (в auth_audit три login_fail внутри одной секунды), и он получил
  // 15-минутную блокировку, гадая, чем плох пароль. Ref обновляется
  // синхронно — именно поэтому засов на нём, а не на состоянии.
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(ESA_NOTICES[esaNotice ?? ''] ?? null);
  // Возврат из ЕСА с включённым вторым фактором приходит сразу на шаг кода.
  const [totpStep, setTotpStep] = useState(totpPending);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const body = {
      username: String(form.get('username') ?? ''),
      password: String(form.get('password') ?? ''),
    };

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        setError(data.message ?? 'Не удалось войти');
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { totpRequired?: boolean };
      if (data.totpRequired) {
        setTotpStep(true);
        return;
      }
      router.replace('/');
      router.refresh();
    } catch {
      setError('Сеть недоступна');
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  async function onSubmitTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    try {
      const res = await fetch('/api/auth/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: String(form.get('code') ?? '') }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        setError(data.message ?? 'Неверный код');
        if (res.status === 401 && (data.message ?? '').includes('истекла')) setTotpStep(false);
        return;
      }
      router.replace('/');
      router.refresh();
    } catch {
      setError('Сеть недоступна');
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">KARMAN</CardTitle>
          <CardDescription>Учёт кредитов — вход в систему</CardDescription>
        </CardHeader>
        <CardContent>
          {totpStep ? (
            <form onSubmit={onSubmitTotp} className="flex flex-col gap-4">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <div className="flex flex-col gap-2">
                <Label htmlFor="code">Код из приложения</Label>
                <Input
                  id="code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123 456"
                  className="font-mono"
                  required
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  Или одноразовый recovery-код (xxxxx-xxxxx), если телефон недоступен.
                </p>
              </div>
              <Button type="submit" disabled={loading} className="w-full">
                {loading ? 'Проверка…' : 'Подтвердить'}
              </Button>
            </form>
          ) : (
            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <div className="flex flex-col gap-2">
                <Label htmlFor="username">Логин</Label>
                <Input id="username" name="username" autoComplete="username" required autoFocus />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">Пароль</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </div>
              <Button type="submit" disabled={loading} className="w-full">
                {loading ? 'Вход…' : 'Войти'}
              </Button>
              {esaEnabled && (
                <>
                  <div className="relative py-1">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t" />
                    </div>
                    <div className="relative flex justify-center">
                      <span className="bg-card px-2 text-xs text-muted-foreground">или</span>
                    </div>
                  </div>
                  {/*
                    Обычная ссылка, а не fetch: это браузерный редирект на чужой
                    домен, и переход должен произойти в самом браузере.
                  */}
                  <Button asChild variant="outline" className="w-full">
                    <a href="/api/auth/oidc/start">Войти через ЕСА вМалмыже</a>
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    Единый вход экосистемы — в том числе через ВКонтакте. Код из приложения
                    аутентификации спрашивается и после него.
                  </p>
                </>
              )}
              <p className="text-center text-xs text-muted-foreground">
                Забыли логин или пароль? Обратитесь к владельцу — он подскажет логин и выдаст
                временный пароль, который вы смените после входа в «Настройках».
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
