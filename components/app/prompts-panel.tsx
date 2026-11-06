'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Archive, ArchiveRestore, Copy, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime } from '@/lib/format';
import {
  archivePromptAction,
  createPromptAction,
  deletePromptAction,
  purgeArchivedPromptsAction,
  restorePromptAction,
} from '@/lib/actions/prompts';
import type { PromptItem, PromptProjectSummary } from '@/lib/prompts/types';

/**
 * Промты (заказ владельца 2026-11-06).
 *
 * Разделы — по проектам; внутри раздела промты свежие сверху. У каждого
 * промта две кнопки: «Копировать» (в буфер — дальше в нейронку) и «В архив»
 * (убрать из живого списка, но НЕ удалить: строка остаётся с датой архивации).
 *
 * Архив — отдельный вид того же списка: там промт можно вернуть в живые или
 * удалить насовсем, а сверху — «Очистить архив», потому что архив имеет
 * свойство разрастаться, а удалять его руками по одной — не работа.
 *
 * Библиотека ЛИЧНАЯ: список уже отфильтрован по владельцу на сервере, и кнопки
 * правят только СВОИ промты. Поэтому гейта «только суперпользователь» здесь
 * нет: каждый вошедший управляет своей библиотекой, а чужие промты закрыты
 * `ownership()` в сервисе.
 */
export function PromptsPanel({
  prompts,
  projects,
  view,
  archivedCount,
}: {
  prompts: PromptItem[];
  projects: PromptProjectSummary[];
  view: 'active' | 'archive';
  archivedCount: number;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [project, setProject] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [before, setBefore] = useState('');

  const groups = useMemo(() => {
    const out: { project: string; items: PromptItem[] }[] = [];
    for (const item of prompts) {
      const last = out[out.length - 1];
      if (last && last.project === item.project) {
        last.items.push(item);
      } else {
        out.push({ project: item.project, items: [item] });
      }
    }
    return out;
  }, [prompts]);

  async function copyPrompt(item: PromptItem) {
    try {
      await navigator.clipboard.writeText(item.body);
      toast.success('Промт скопирован');
    } catch {
      toast.error('Не удалось скопировать — скопируйте текст вручную');
    }
  }

  async function run(item: PromptItem, job: () => Promise<{ ok: boolean; error?: string }>) {
    setBusyId(item.id);
    try {
      const result = await job();
      if (!result.ok) {
        toast.error(result.error ?? 'Не получилось');
        return;
      }
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setAdding(true);
    try {
      const result = await createPromptAction({ project, title, body });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setProject('');
      setTitle('');
      setBody('');
      toast.success('Промт добавлен');
      router.refresh();
    } finally {
      setAdding(false);
    }
  }

  async function purge() {
    const result = await purgeArchivedPromptsAction(before ? { before } : {});
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(
      result.data?.removed
        ? `Убрано из архива: ${result.data.removed}`
        : 'В архиве было пусто',
    );
    router.refresh();
  }

  const isArchive = view === 'archive';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold">Промты</h1>
        <Badge variant="outline">
          {isArchive ? `${prompts.length} в архиве` : `${prompts.length} живых`}
        </Badge>
        <div className="ml-auto flex gap-2">
          <Button asChild size="sm" variant={isArchive ? 'outline' : 'default'}>
            <Link href="/map?tab=prompts">Живые</Link>
          </Button>
          <Button asChild size="sm" variant={isArchive ? 'default' : 'outline'}>
            <Link href="/map?tab=prompts&view=archive">Архив</Link>
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Промты раскладывает Мозг по проектам — по вашей команде в чате. Здесь они
        копируются в буфер и уходят в нейронку. Архив — это убранное из живого
        списка, но сохранённое: вернуть можно всегда, удалить — только руками.
      </p>

      {!isArchive ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Добавить промт</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-3" onSubmit={submit}>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Input
                  className="sm:w-64"
                  list="prompt-projects"
                  placeholder="Проект"
                  value={project}
                  onChange={(event) => setProject(event.target.value)}
                />
                <datalist id="prompt-projects">
                  {projects.map((item) => (
                    <option key={item.project} value={item.project} />
                  ))}
                </datalist>
                <Input
                  className="sm:flex-1"
                  placeholder="Заголовок (если без него — возьмём первую строку)"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <Textarea
                placeholder="Текст промта"
                rows={6}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
              <div>
                <Button type="submit" disabled={adding || !body.trim() || !project.trim()}>
                  <Plus className="mr-1 h-4 w-4" />
                  Добавить
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {isArchive ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2">
          <span className="text-sm text-muted-foreground">
            В архиве {archivedCount} промт(ов). Чистка — безвозвратная.
          </span>
          <Input
            className="h-8 w-44"
            type="date"
            title="Очистить только старше этой даты"
            value={before}
            onChange={(event) => setBefore(event.target.value)}
          />
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="outline">
                <Trash2 className="mr-1 h-4 w-4" />
                {before ? 'Очистить старше даты' : 'Очистить архив'}
              </Button>
            }
            title={before ? 'Очистить архив старше даты?' : 'Очистить архив целиком?'}
            description={
              before
                ? 'Архивные промты старше указанной даты будут удалены безвозвратно. Живые не пострадают.'
                : 'Все архивные промты будут удалены безвозвратно. Живые не пострадают.'
            }
            confirmText="Удалить"
            onConfirm={purge}
          />
        </div>
      ) : null}

      {groups.length === 0 ? (
        <p className="rounded-md border bg-card px-3 py-4 text-sm text-muted-foreground">
          {isArchive
            ? 'Архив пуст — сюда попадают промты, отправленные в архив.'
            : 'Промтов пока нет. Скиньте текст в чат и скажите: «добавь это в промты».'}
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.project}>
            <h2 className="mb-2 flex items-center gap-2 text-lg font-medium">
              {group.project}
              <Badge variant="secondary">{group.items.length}</Badge>
            </h2>
            <ul className="flex flex-col gap-2">
              {group.items.map((item) => (
                <li key={item.id} className="rounded-md border bg-card px-3 py-2">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-medium">{item.title || 'Без названия'}</span>
                    <Badge variant="outline">
                      {item.source === 'brain' ? 'Мозг' : 'Вручную'}
                    </Badge>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {isArchive && item.archivedAt
                        ? `в архиве с ${formatDateTime(item.archivedAt)} · создан ${formatDateTime(item.createdAt)}`
                        : `создан ${formatDateTime(item.createdAt)}`}
                    </span>
                  </div>
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-sm">
                    {item.body}
                  </pre>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => copyPrompt(item)}>
                      <Copy className="mr-1 h-4 w-4" />
                      Копировать
                    </Button>
                    {!isArchive ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === item.id}
                        onClick={() =>
                          run(item, () => archivePromptAction(item.id)).then(() =>
                            toast.success('Промт в архиве'),
                          )
                        }
                      >
                        <Archive className="mr-1 h-4 w-4" />
                        В архив
                      </Button>
                    ) : null}
                    {isArchive ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === item.id}
                          onClick={() =>
                            run(item, () => restorePromptAction(item.id)).then(() =>
                              toast.success('Промт вернулся в живые'),
                            )
                          }
                        >
                          <ArchiveRestore className="mr-1 h-4 w-4" />
                          Вернуть
                        </Button>
                        <ConfirmDialog
                          trigger={
                            <Button size="sm" variant="outline" disabled={busyId === item.id}>
                              <Trash2 className="mr-1 h-4 w-4" />
                              Удалить
                            </Button>
                          }
                          title="Удалить промт навсегда?"
                          description="Строка исчезнет из базы. Отменить будет нельзя."
                          confirmText="Удалить"
                          onConfirm={async () => {
                            await run(item, () => deletePromptAction(item.id));
                            toast.success('Промт удалён');
                          }}
                        />
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
