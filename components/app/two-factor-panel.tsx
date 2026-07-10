'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, ShieldCheck, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  startTotpEnrollmentAction,
  confirmTotpEnrollmentAction,
  disableTotpAction,
} from '@/lib/actions/twofactor';

type Enrollment = { otpauthUri: string; qrDataUrl: string; secret: string };

export function TwoFactorPanel({
  enabled,
  recoveryLeft,
}: {
  enabled: boolean;
  recoveryLeft: number;
}) {
  const router = useRouter();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    const result = await startTotpEnrollmentAction();
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setEnrollment(result.data!);
  }

  async function confirm() {
    setBusy(true);
    const result = await confirmTotpEnrollmentAction({ code });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setEnrollment(null);
    setCode('');
    setRecoveryCodes(result.data!.recoveryCodes);
    toast.success('2FA включена');
  }

  async function disable() {
    setBusy(true);
    const result = await disableTotpAction({ code });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setCode('');
    toast.success('2FA отключена');
    router.refresh();
  }

  async function copyRecovery() {
    if (!recoveryCodes) return;
    await navigator.clipboard.writeText(recoveryCodes.join('\n'));
    toast.success('Коды скопированы');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {enabled ? <ShieldCheck className="h-5 w-5 text-green-600" /> : <ShieldOff className="h-5 w-5 text-muted-foreground" />}
          Двухфакторная аутентификация (TOTP)
        </CardTitle>
        <CardDescription>
          Второй фактор входа кодом из приложения (Google Authenticator, Aegis и т.п.).
          После включения раздел «Секреты» доступен только сессиям, вошедшим с кодом.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {recoveryCodes && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
            <p className="text-sm font-medium">
              Recovery-коды — сохраните сейчас, показываются один раз.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Каждый работает один раз вместо кода из приложения (если телефон недоступен).
            </p>
            <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-5">
              {recoveryCodes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            <Button size="sm" variant="outline" className="mt-2" onClick={copyRecovery}>
              <Copy className="mr-1 h-4 w-4" /> Скопировать все
            </Button>
          </div>
        )}

        {enabled || recoveryCodes ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              2FA <b>включена</b>. Неиспользованных recovery-кодов: {recoveryCodes ? recoveryCodes.length : recoveryLeft}.
            </p>
            <div className="flex items-end gap-2">
              <div className="grid gap-1">
                <Label htmlFor="disable-code" className="text-xs">Код для отключения</Label>
                <Input
                  id="disable-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123 456"
                  autoComplete="one-time-code"
                  className="w-36 font-mono"
                />
              </div>
              <Button variant="destructive" disabled={busy || code.trim().length < 6} onClick={disable}>
                Отключить 2FA
              </Button>
            </div>
          </div>
        ) : enrollment ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              1. Отсканируйте QR приложением-аутентификатором (или введите секрет вручную).
            </p>
            <div className="flex flex-wrap items-center gap-4">
              {/* data:-URL QR, сгенерирован на сервере — next/image тут не нужен */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={enrollment.qrDataUrl} alt="QR для приложения-аутентификатора" width={220} height={220} className="rounded-md border" />
              <div className="min-w-0 text-xs text-muted-foreground">
                <p>Секрет (ручной ввод):</p>
                <p className="mt-1 break-all font-mono text-sm text-foreground">{enrollment.secret}</p>
              </div>
            </div>
            <p className="text-sm">2. Введите код из приложения для подтверждения:</p>
            <div className="flex items-end gap-2">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123 456"
                autoComplete="one-time-code"
                className="w-36 font-mono"
              />
              <Button disabled={busy || code.trim().length < 6} onClick={confirm}>
                Подтвердить и включить
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button onClick={start} disabled={busy}>
              {busy ? 'Готовим QR…' : 'Включить 2FA'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
