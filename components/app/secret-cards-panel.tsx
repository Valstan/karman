'use client';

import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { Plus, Pencil, Trash2, Eye, EyeOff, Copy, ExternalLink, Upload } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ConfirmDialog } from './confirm-dialog';
import {
  createCardAction,
  updateCardAction,
  deleteCardAction,
  upsertCardFieldAction,
  deleteCardFieldAction,
  revealCardFieldAction,
  importCardsAction,
  upsertItemAction,
  revealItemAction,
} from '@/lib/actions/secrets';
import { formatDate } from '@/lib/format';
import type { SecretCardListItem, SecretItemMeta } from '@/lib/services/secrets';

const KIND_LABELS: Record<string, string> = { text: 'Текст', secret: 'Секрет', url: 'Ссылка' };

/** Диалог создания/переименования карточки (наименование + программное обозначение). */
function CardMetaDialog({
  projectId,
  card,
  trigger,
}: {
  projectId: number;
  card?: { id: number; title: string; envKey: string | null };
  trigger: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const isEdit = Boolean(card);
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<{ title: string; envKey: string }>({
    defaultValues: { title: card?.title ?? '', envKey: card?.envKey ?? '' },
  });

  async function onSubmit(values: { title: string; envKey: string }) {
    const payload = { title: values.title, envKey: values.envKey.trim() };
    const result = card
      ? await updateCardAction({ id: card.id, ...payload })
      : await createCardAction({ projectId, ...payload });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(isEdit ? 'Карточка обновлена' : 'Карточка создана');
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset({ title: card?.title ?? '', envKey: card?.envKey ?? '' });
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Изменить карточку' : 'Новая карточка'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="card-title">Наименование</Label>
            <Input id="card-title" required placeholder="Ключ ВК для авторизации" {...register('title')} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="card-env">Программное обозначение (env, необязательно)</Label>
            <Input id="card-env" placeholder="SECRET_KEY_VK" className="font-mono" {...register('envKey')} />
            <p className="text-xs text-muted-foreground">
              Как ключ записан в env на проде. Пусто — личная карточка без env-связки.
            </p>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Сохранение…' : isEdit ? 'Сохранить' : 'Создать'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Форма добавления/изменения поля карточки. */
function FieldForm({ cardId, existing, onDone }: {
  cardId: number;
  existing?: { name: string; kind: string };
  onDone: () => void;
}) {
  const [kind, setKind] = useState(existing?.kind ?? 'text');
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<{ name: string; value: string }>({
    defaultValues: { name: existing?.name ?? '', value: '' },
  });

  async function onSubmit(values: { name: string; value: string }) {
    const result = await upsertCardFieldAction({ cardId, name: values.name, kind, value: values.value });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Поле сохранено');
    reset({ name: '', value: '' });
    setKind('text');
    onDone();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="grid gap-3 rounded-md border p-3">
      <div className="grid grid-cols-[1fr_130px] gap-2">
        <div className="grid gap-1">
          <Label htmlFor="field-name" className="text-xs">Имя поля</Label>
          <Input
            id="field-name"
            required
            readOnly={Boolean(existing)}
            placeholder="Логин / Описание / Ссылка…"
            {...register('name')}
          />
        </div>
        <div className="grid gap-1">
          <Label className="text-xs">Тип</Label>
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(KIND_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="field-value" className="text-xs">
          Значение{existing ? ' (будет записано новое)' : ''}
        </Label>
        <Textarea id="field-value" required rows={2} autoComplete="off" className="font-mono" {...register('value')} />
      </div>
      <Button type="submit" size="sm" disabled={isSubmitting} className="justify-self-end">
        {isSubmitting ? 'Сохранение…' : existing ? 'Сохранить значение' : 'Добавить поле'}
      </Button>
    </form>
  );
}

/** Диалог просмотра карточки: поля с расшифровкой по клику + env-значение. */
function CardViewDialog({
  projectId,
  card,
  envItem,
  trigger,
}: {
  projectId: number;
  card: SecretCardListItem;
  envItem: SecretItemMeta | undefined;
  trigger: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [envValue, setEnvValue] = useState<string | null>(null);
  const [editField, setEditField] = useState<{ name: string; kind: string } | null>(null);

  async function fieldValue(id: number): Promise<string | null> {
    if (id in revealed) return revealed[id]!;
    const result = await revealCardFieldAction(id);
    if (!result.ok) {
      toast.error(result.error);
      return null;
    }
    setRevealed((prev) => ({ ...prev, [id]: result.data!.value }));
    return result.data!.value;
  }

  async function toggleReveal(id: number) {
    if (id in revealed) {
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    await fieldValue(id);
  }

  async function copyField(id: number) {
    const value = await fieldValue(id);
    if (value === null) return;
    await navigator.clipboard.writeText(value);
    toast.success('Скопировано');
  }

  async function removeField(id: number) {
    const result = await deleteCardFieldAction(id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Поле удалено');
    router.refresh();
  }

  async function toggleEnvValue() {
    if (envValue !== null) {
      setEnvValue(null);
      return;
    }
    if (!envItem) return;
    const result = await revealItemAction(envItem.id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setEnvValue(result.data!.value);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setRevealed({});
          setEnvValue(null);
          setEditField(null);
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{card.title}</DialogTitle>
        </DialogHeader>

        {card.envKey && (
          <div className="rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Значение env-ключа</p>
                <p className="truncate font-mono text-sm font-medium">{card.envKey}</p>
              </div>
              {envItem ? (
                <Button size="icon" variant="ghost" title={envValue !== null ? 'Скрыть' : 'Показать'} onClick={toggleEnvValue}>
                  {envValue !== null ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              ) : (
                <EnvValueDialog
                  projectId={projectId}
                  envKey={card.envKey}
                  trigger={<Button size="sm" variant="outline">Задать значение</Button>}
                />
              )}
            </div>
            {envValue !== null && <p className="mt-2 break-all font-mono text-sm">{envValue}</p>}
            {envItem && (
              <p className="mt-1 text-xs text-muted-foreground">
                Живёт среди секретов комнаты — то же значение видит машинный API.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2">
          {card.fields.length === 0 && (
            <p className="py-2 text-center text-sm text-muted-foreground">Полей пока нет.</p>
          )}
          {card.fields.map((f) => (
            <div key={f.id} className="rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {f.name}{' '}
                    <Badge variant="outline" className="ml-1 align-middle">{KIND_LABELS[f.kind] ?? f.kind}</Badge>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="icon" variant="ghost" title={f.id in revealed ? 'Скрыть' : 'Показать'} onClick={() => toggleReveal(f.id)}>
                    {f.id in revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                  <Button size="icon" variant="ghost" title="Скопировать" onClick={() => copyField(f.id)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" title="Изменить значение" onClick={() => setEditField({ name: f.name, kind: f.kind })}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <ConfirmDialog
                    title="Удалить поле?"
                    description={`Поле «${f.name}» будет удалено безвозвратно.`}
                    onConfirm={() => removeField(f.id)}
                    trigger={
                      <Button size="icon" variant="ghost" title="Удалить">
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    }
                  />
                </div>
              </div>
              {f.id in revealed && (
                f.kind === 'url' ? (
                  <a
                    href={revealed[f.id]}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1 break-all font-mono text-sm underline"
                  >
                    {revealed[f.id]} <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                ) : (
                  <p className="mt-2 whitespace-pre-wrap break-all font-mono text-sm">{revealed[f.id]}</p>
                )
              )}
            </div>
          ))}
        </div>

        {editField ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Изменить «{editField.name}»</p>
              <Button size="sm" variant="ghost" onClick={() => setEditField(null)}>Отмена</Button>
            </div>
            <FieldForm
              cardId={card.id}
              existing={editField}
              onDone={() => {
                setEditField(null);
                setRevealed({});
                router.refresh();
              }}
            />
          </div>
        ) : (
          <FieldForm cardId={card.id} onDone={() => router.refresh()} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Диалог первичного значения env-ключа карточки (создаёт secrets_item). */
function EnvValueDialog({
  projectId,
  envKey,
  trigger,
}: {
  projectId: number;
  envKey: string;
  trigger: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<{ value: string }>({ defaultValues: { value: '' } });

  async function onSubmit(values: { value: string }) {
    const result = await upsertItemAction({ projectId, key: envKey, value: values.value });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Значение записано');
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset({ value: '' });
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Значение: {envKey}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="env-value">Значение</Label>
            <Textarea id="env-value" required rows={2} autoComplete="off" className="font-mono" {...register('value')} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Сохранение…' : 'Записать'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Импорт карточек из CSV-файла (экспорт браузерного менеджера паролей и т.п.). */
function CardImportDialog({ projectId, trigger }: { projectId: number; trigger: ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setCsv(await file.text());
  }

  async function submit() {
    if (!csv) {
      toast.error('Выберите CSV-файл');
      return;
    }
    setBusy(true);
    const result = await importCardsAction({ projectId, csv });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    const { imported, skipped } = result.data!;
    toast.success(`Импортировано карточек: ${imported}${skipped ? `, пропущено строк: ${skipped}` : ''}`);
    setOpen(false);
    setCsv('');
    setFileName(null);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setCsv('');
          setFileName(null);
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Импорт карточек из CSV</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            Экспорт браузерного менеджера паролей (Chrome/Firefox: столбцы
            name, url, username, password, note) или любой CSV: первый/именованный
            столбец — наименование, остальные — поля карточки. Значения шифруются.
          </p>
          <div className="grid gap-2">
            <Label htmlFor="csv-file">CSV-файл</Label>
            <Input id="csv-file" type="file" accept=".csv,text/csv" onChange={onFile} />
            {fileName && <p className="text-xs text-muted-foreground">Выбран: {fileName}</p>}
          </div>
          <DialogFooter>
            <Button onClick={submit} disabled={busy || !csv}>
              {busy ? 'Импорт…' : 'Импортировать'}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function SecretCardsPanel({
  projectId,
  cards,
  items,
}: {
  projectId: number;
  cards: SecretCardListItem[];
  items: SecretItemMeta[];
}) {
  const router = useRouter();

  async function removeCard(id: number) {
    const result = await deleteCardAction(id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Карточка удалена');
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Карточки</h2>
        <div className="flex items-center gap-2">
          <CardImportDialog
            projectId={projectId}
            trigger={
              <Button size="sm" variant="outline">
                <Upload className="mr-1 h-4 w-4" /> Импорт CSV
              </Button>
            }
          />
          <CardMetaDialog
            projectId={projectId}
            trigger={
              <Button size="sm">
                <Plus className="mr-1 h-4 w-4" /> Карточка
              </Button>
            }
          />
        </div>
      </div>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Наименование</TableHead>
              <TableHead>Обозначение</TableHead>
              <TableHead>Поля</TableHead>
              <TableHead>Изменена</TableHead>
              <TableHead className="text-right">Действия</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cards.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                  Карточек пока нет. Карточка — наименование, описание, ссылка и любые поля
                  к секрету; env-значения продолжают жить в «Секретах» ниже.
                </TableCell>
              </TableRow>
            )}
            {cards.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="text-sm font-medium">
                  <CardViewDialog
                    projectId={projectId}
                    card={c}
                    envItem={items.find((it) => it.key === c.envKey)}
                    trigger={
                      <button type="button" className="text-left underline-offset-2 hover:underline">
                        {c.title}
                      </button>
                    }
                  />
                </TableCell>
                <TableCell className="font-mono text-sm">{c.envKey ?? '—'}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{c.fields.length}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{formatDate(c.updatedAt)}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <CardMetaDialog
                      projectId={projectId}
                      card={{ id: c.id, title: c.title, envKey: c.envKey }}
                      trigger={
                        <Button size="icon" variant="ghost" title="Изменить наименование/обозначение">
                          <Pencil className="h-4 w-4" />
                        </Button>
                      }
                    />
                    <ConfirmDialog
                      title="Удалить карточку?"
                      description={`Карточка «${c.title}» и её поля будут удалены безвозвратно. Env-значение в «Секретах» (если есть) останется.`}
                      onConfirm={() => removeCard(c.id)}
                      trigger={
                        <Button size="icon" variant="ghost" title="Удалить">
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      }
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
