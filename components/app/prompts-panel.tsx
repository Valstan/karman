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
import type { PromptItem, PromptSection } from '@/lib/prompts/types';

/**
 * Промты (заказ владельца 2026-11-06).
 *
 * Экран поделён пополам: слева — разделы (проекты) и названия промтов, справа —
 * весь выбранный промт целиком. Текст в списке не показывается: названия
 * достаточно, чтобы выбрать, а весь текст нужен в одном месте.
 *
 * Прокрутка у колонок СВОЯ: листая правую, левая остаётся на месте — видно,
 * какой промт открыт и где ты в списке. Поэтому у колонок ограниченная высота
 * и `overflow-y-auto` на каждой, а не общая прокрутка страницы.
 *
 * Разделы берутся из РЕЕСТРА (`prompt_project`), а не «посчитываются» из промтов:
 * заранее заведённый раздел без промтов виден как пустой. Библиотека ЛИЧНАЯ:
 * список уже отфильтрован по владельцу на сервере, и кнопки правят только
 * СВОИ промты.
 */
export function PromptsPanel({
  prompts,
  sections,
  view,
  archivedCount,
}: {
  prompts: PromptItem[];
  sections: PromptSection[];
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
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Промты по разделам. Раздел берётся из реестра, но если промт попал в
  // раздел, которого в реестре нет (запись обошла реестр), он не должен
  // потеряться — такой раздел показываем последним.
  const grouped = useMemo(() => {
    const known = new Set(sections.map((s) => s.name));
    const map = new Map<string, PromptItem[]>();
    for (const section of sections) map.set(section.name, []);
    for (const item of prompts) {
      if (!known.has(item.project) && !map.has(item.project)) map.set(item.project, []);
      map.get(item.project)!.push(item);
    }
    return [...map.entries()]
      .map(([name, items]) => ({ name, items }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [prompts, sections]);

  // Выбранный промт: по умолчанию — первый в списке. Если выбранного в текущем
  // виде нет (переключили «живые ↔ архив»), показываем первый. Отдельного
  // эффекта для синхронизации не нужно: выбор хранится в состоянии, а подмена
  // «на первый» считается прямо здесь.
  const selected = useMemo(() => {
    const all = grouped.flatMap((g) => g.items);
    return all.find((p) => p.id === selectedId) ?? all[0] ?? null;
  }, [grouped, selectedId]);

  async function copyPrompt(item: PromptItem) {
    try {
      await navigator.clipboard.writeText(item.body);
      toast.success('Промт скопирован');
    } catch {
      toast.error('Не удалось скопировать — скопируйте текст вручную');
    }
  }

  async function run(job: () => Promise<{ ok: boolean; error?: string }>) {
    try {
      const result = await job();
      if (!result.ok) {
        toast.error(result.error ?? 'Не получилось');
        return false;
      }
      router.refresh();
      return true;
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
      result.data?.removed ? `Убрано из архива: ${result.data.removed}` : 'В архиве было пусто',
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
                placeholder="Проект (раздел)"
                value={project}
                onChange={(event) => setProject(event.target.value)}
              />
              <datalist id="prompt-projects">
                {sections.map((section) => (
                  <option key={section.name} value={section.name} />
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
              rows={5}
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

      {isArchive && (
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
      )}

      <div className="grid gap-4 lg:h-[70vh] lg:grid-cols-[minmax(220px,1fr)_minmax(0,2fr)]">
        {/* Левая колонка: разделы и названия промтов. Своя прокрутка. */}
        <div className="min-h-0 overflow-y-auto rounded-md border bg-card p-3">
          {grouped.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {isArchive
                ? 'Архив пуст — сюда попадают промты, отправленные в архив.'
                : 'Промтов пока нет. Скиньте текст в чат и скажите: «добавь это в промты».'}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {grouped.map((group) => (
                <div key={group.name}>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-sm font-semibold">{group.name}</span>
                    <Badge variant="secondary">{group.items.length}</Badge>
                  </div>
                  {group.items.length === 0 ? (
                    <p className="pl-1 text-xs text-muted-foreground">пусто</p>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {group.items.map((item) => {
                        const active = selected?.id === item.id;
                        return (
                          <li key={item.id}>
                            <button
                              type="button"
                              onClick={() => setSelectedId(item.id)}
                              className={
                                active
                                  ? 'w-full truncate rounded px-2 py-1 text-left text-sm font-medium ring-1 ring-ring'
                                  : 'w-full truncate rounded px-2 py-1 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground'
                              }
                              title={item.title}
                            >
                              {item.title || 'Без названия'}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Правая колонка: весь выбранный промт. Своя прокрутка. */}
        <div className="min-h-0 overflow-y-auto rounded-md border bg-card p-4">
          {!selected ? (
            <p className="text-sm text-muted-foreground">
              Слева — разделы и промты. Выберите промт, и здесь появится его текст целиком.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-lg font-semibold">{selected.title || 'Без названия'}</h2>
                <Badge variant="outline">{selected.source === 'brain' ? 'Мозг' : 'Вручную'}</Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                  {isArchive && selected.archivedAt
                    ? `в архиве с ${formatDateTime(selected.archivedAt)} · создан ${formatDateTime(selected.createdAt)}`
                    : `создан ${formatDateTime(selected.createdAt)}`}
                </span>
              </div>
              <pre className="whitespace-pre-wrap rounded bg-muted p-3 text-sm">{selected.body}</pre>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => copyPrompt(selected)}>
                  <Copy className="mr-1 h-4 w-4" />
                  Копировать
                </Button>
                {!isArchive ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === selected.id}
                    onClick={async () => {
                      setBusyId(selected.id);
                      const ok = await run(() => archivePromptAction(selected.id));
                      if (ok) toast.success('Промт в архиве');
                    }}
                  >
                    <Archive className="mr-1 h-4 w-4" />
                    В архив
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === selected.id}
                      onClick={async () => {
                        setBusyId(selected.id);
                        const ok = await run(() => restorePromptAction(selected.id));
                        if (ok) toast.success('Промт вернулся в живые');
                      }}
                    >
                      <ArchiveRestore className="mr-1 h-4 w-4" />
                      Вернуть
                    </Button>
                    <ConfirmDialog
                      trigger={
                        <Button size="sm" variant="outline" disabled={busyId === selected.id}>
                          <Trash2 className="mr-1 h-4 w-4" />
                          Удалить
                        </Button>
                      }
                      title="Удалить промт навсегда?"
                      description="Строка исчезнет из базы. Отменить будет нельзя."
                      confirmText="Удалить"
                      onConfirm={async () => {
                        setBusyId(selected.id);
                        const ok = await run(() => deletePromptAction(selected.id));
                        if (ok) toast.success('Промт удалён');
                      }}
                    />
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
