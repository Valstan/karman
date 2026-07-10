'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totpStep, setTotpStep] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      setLoading(false);
    }
  }

  async function onSubmitTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
