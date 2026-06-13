'use client';

import { useState } from 'react';
import { Send, Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { generateTelegramLinkAction } from '@/lib/actions/telegram-link';

export function TelegramLinkPanel({
  configured,
  linked,
  username,
}: {
  configured: boolean;
  linked: boolean;
  username: string | null;
}) {
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function generate() {
    setLoading(true);
    const res = await generateTelegramLinkAction();
    setLoading(false);
    if (!res.ok || !res.data) {
      toast.error(res.ok ? 'Не удалось получить ссылку' : res.error);
      return;
    }
    setDeepLink(res.data.deepLink);
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Send className="h-5 w-5" /> Telegram-напоминания
        </CardTitle>
        <CardDescription>
          Привяжите Telegram, чтобы получать напоминания о платежах и документах сообщениями.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!configured ? (
          <p className="text-sm text-muted-foreground">
            Telegram-бот ещё не настроен на сервере. Обратитесь к администратору.
          </p>
        ) : linked ? (
          <div className="flex items-center gap-2 text-sm">
            <Check className="h-4 w-4 text-green-600" />
            <span>
              Привязан{username ? <> (@{username})</> : null}. Напоминания приходят в Telegram.
            </span>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Аккаунт Telegram ещё не привязан.</p>
        )}

        {configured && (
          <div className="flex flex-col gap-3">
            <Button onClick={generate} disabled={loading} className="w-fit">
              {loading ? 'Готовлю ссылку…' : linked ? 'Перепривязать' : 'Сгенерировать ссылку'}
            </Button>

            {deepLink && (
              <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
                <p className="text-muted-foreground">
                  Откройте ссылку и нажмите «Start» в Telegram (действует 15 минут):
                </p>
                <div className="flex items-center gap-2">
                  <a
                    href={deepLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all font-medium text-primary underline"
                  >
                    {deepLink}
                  </a>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Скопировать ссылку"
                    onClick={() => {
                      navigator.clipboard.writeText(deepLink).then(
                        () => toast.success('Ссылка скопирована'),
                        () => toast.error('Не удалось скопировать'),
                      );
                    }}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
