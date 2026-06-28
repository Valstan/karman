'use client';

import { useState, useMemo, type ReactNode } from 'react';
import { useForm, useWatch, Controller } from 'react-hook-form';
import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
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
import { cn } from '@/lib/utils';
import { createReminderAction, updateReminderAction } from '@/lib/actions/reminders';
import {
  QUIET_HOURS_DEFAULT,
  specToFormValues,
  formValuesToSpec,
  formatMoscowInstant,
  WEEKDAY_LABELS,
  WEEKDAY_ORDER,
  type ReminderFormValues,
} from '@/lib/reminders/spec-display';
import { nextFires } from '@/lib/reminders/schedule';
import type { ReminderListItem } from '@/lib/services/reminders';

function defaults(reminder?: ReminderListItem): ReminderFormValues {
  const base: ReminderFormValues = {
    title: reminder?.title ?? '',
    body: reminder?.body ?? '',
    at: '',
    priority: reminder?.priority ?? 'normal',
    silent: reminder?.silent ?? false,
    repeat: 'none',
    interval: 1,
    weekdays: [],
    monthday: '',
    dates: [],
    datesTime: '09:00',
    endType: 'never',
    endN: '',
    endUntil: '',
    businessDaysOnly: false,
    quietEnabled: false,
    quietFrom: '',
    quietTo: '',
    quietDefer: '',
  };
  return { ...base, ...specToFormValues(reminder?.spec ?? null) };
}

export function ReminderFormDialog({
  trigger,
  reminder,
}: {
  trigger: ReactNode;
  reminder?: ReminderListItem;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const isEdit = Boolean(reminder);
  const {
    register,
    handleSubmit,
    control,
    getValues,
    reset,
    setValue,
    formState: { isSubmitting },
  } = useForm<ReminderFormValues>({ defaultValues: defaults(reminder) });

  const repeat = useWatch({ control, name: 'repeat' });
  const endType = useWatch({ control, name: 'endType' });
  const quietEnabled = useWatch({ control, name: 'quietEnabled' });
  const isRecurring = repeat === 'daily' || repeat === 'weekly' || repeat === 'monthly' || repeat === 'yearly';
  const isDates = repeat === 'dates';

  // Живой предпросмотр «когда сработает»: строим спеку из текущих значений (зеркало
  // серверного buildSpec) и считаем ближайшие срабатывания. Сервер — источник правды.
  const allValues = useWatch({ control });
  const preview = useMemo(() => {
    const v = allValues as ReminderFormValues | undefined;
    if (!v) return { valid: false, fires: [] as string[] };
    const hasInput =
      v.repeat === 'dates'
        ? (v.dates?.filter(Boolean).length ?? 0) > 0
        : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v.at ?? '');
    if (!hasInput) return { valid: false, fires: [] as string[] };
    try {
      const spec = formValuesToSpec(v);
      return { valid: true, fires: nextFires(spec, new Date().toISOString(), 5) };
    } catch {
      return { valid: false, fires: [] as string[] };
    }
  }, [allValues]);

  async function onSubmit(v: ReminderFormValues) {
    const common = { title: v.title, body: v.body, priority: v.priority, silent: v.silent };
    let payload: Record<string, unknown>;
    if (v.repeat === 'dates') {
      // Произвольные даты: at/повтор/доставка/окончание не нужны.
      const dates = [...new Set(v.dates.filter(Boolean))].sort();
      payload = {
        ...common,
        repeat: 'dates',
        dates,
        ...(v.datesTime ? { datesTime: v.datesTime } : {}),
      };
    } else {
      const recurring = v.repeat !== 'none';
      const quietOn = recurring && v.quietEnabled;
      payload = {
        ...common,
        at: v.at,
        repeat: v.repeat,
        interval: Number(v.interval) || 1,
        weekdays: v.repeat === 'weekly' ? v.weekdays : [],
        ...(v.repeat === 'monthly' && v.monthday ? { monthday: Number(v.monthday) } : {}),
        endType: v.endType,
        ...(v.endType === 'afterN' && v.endN ? { endN: Number(v.endN) } : {}),
        ...(v.endType === 'until' && v.endUntil ? { endUntil: v.endUntil } : {}),
        businessDaysOnly: recurring && v.businessDaysOnly,
        quietEnabled: quietOn,
        ...(quietOn
          ? {
              quietFrom: v.quietFrom || QUIET_HOURS_DEFAULT.from,
              quietTo: v.quietTo || QUIET_HOURS_DEFAULT.to,
              quietDefer: v.quietDefer || QUIET_HOURS_DEFAULT.deferTo,
            }
          : {}),
      };
    }

    const result = isEdit
      ? await updateReminderAction({ id: reminder!.id, ...payload })
      : await createReminderAction(payload);

    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(isEdit ? 'Напоминание обновлено' : 'Напоминание создано');
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset(defaults(reminder));
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Редактировать напоминание' : 'Новое напоминание'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="title">Заголовок</Label>
            <Input id="title" required maxLength={200} {...register('title')} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="body">Текст (необязательно)</Label>
            <Textarea id="body" rows={2} {...register('body')} />
          </div>
          {!isDates && (
            <div className="grid gap-2">
              <Label htmlFor="at">{repeat === 'none' ? 'Когда (МСК)' : 'Начало (МСК)'}</Label>
              <Input id="at" type="datetime-local" required {...register('at')} />
            </div>
          )}

          <div className="grid gap-2">
            <Label>Повтор</Label>
            <Controller
              control={control}
              name="repeat"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Не повторять</SelectItem>
                    <SelectItem value="daily">Каждый день</SelectItem>
                    <SelectItem value="weekly">Каждую неделю</SelectItem>
                    <SelectItem value="monthly">Каждый месяц</SelectItem>
                    <SelectItem value="yearly">Каждый год</SelectItem>
                    <SelectItem value="dates">По датам (вручную)</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          {isDates && (
            <div className="grid gap-2 rounded-md border p-3">
              <Label className="text-sm font-medium">Даты срабатывания (МСК)</Label>
              <Controller
                control={control}
                name="dates"
                render={({ field }) => (
                  <div className="flex flex-col gap-2">
                    {field.value.length === 0 && (
                      <p className="text-sm text-muted-foreground">Дат пока нет — добавьте ниже.</p>
                    )}
                    {field.value.map((d, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input
                          type="date"
                          className="w-44"
                          value={d}
                          onChange={(e) =>
                            field.onChange(field.value.map((x, j) => (j === i ? e.target.value : x)))
                          }
                        />
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          title="Убрать дату"
                          onClick={() => field.onChange(field.value.filter((_, j) => j !== i))}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="self-start"
                      onClick={() => field.onChange([...field.value, ''])}
                    >
                      <Plus className="mr-1 h-4 w-4" /> Добавить дату
                    </Button>
                  </div>
                )}
              />
              <div className="flex items-center gap-2">
                <Label htmlFor="datesTime" className="whitespace-nowrap text-sm">
                  Время (для всех)
                </Label>
                <Input id="datesTime" type="time" className="w-28" {...register('datesTime')} />
              </div>
              <p className="text-xs text-muted-foreground">
                Сработает в указанное время каждой даты. Повтор/окончание здесь не применяются.
              </p>
            </div>
          )}

          {isRecurring && (
            <div className="flex items-center gap-2">
              <Label htmlFor="interval" className="whitespace-nowrap">
                Каждые
              </Label>
              <Input
                id="interval"
                type="number"
                min={1}
                max={366}
                className="w-20"
                {...register('interval')}
              />
              <span className="text-sm text-muted-foreground">
                {repeat === 'daily' && 'дн.'}
                {repeat === 'weekly' && 'нед.'}
                {repeat === 'monthly' && 'мес.'}
                {repeat === 'yearly' && 'г.'}
              </span>
            </div>
          )}

          {repeat === 'weekly' && (
            <div className="grid gap-2">
              <Label>Дни недели</Label>
              <Controller
                control={control}
                name="weekdays"
                render={({ field }) => (
                  <div className="flex flex-wrap gap-1">
                    {WEEKDAY_ORDER.map((d) => {
                      const active = field.value.includes(d);
                      return (
                        <button
                          key={d}
                          type="button"
                          onClick={() =>
                            field.onChange(
                              active ? field.value.filter((x) => x !== d) : [...field.value, d],
                            )
                          }
                          className={cn(
                            'rounded-md border px-2.5 py-1 text-sm',
                            active
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'text-muted-foreground hover:bg-accent',
                          )}
                        >
                          {WEEKDAY_LABELS[d]}
                        </button>
                      );
                    })}
                  </div>
                )}
              />
              <p className="text-xs text-muted-foreground">
                Если не выбрать — по дню недели из даты начала.
              </p>
            </div>
          )}

          {repeat === 'monthly' && (
            <div className="flex items-center gap-2">
              <Label htmlFor="monthday" className="whitespace-nowrap">
                Число месяца
              </Label>
              <Input
                id="monthday"
                type="number"
                min={1}
                max={31}
                className="w-20"
                placeholder="из даты"
                {...register('monthday')}
              />
              <span className="text-xs text-muted-foreground">31 → последний день короткого месяца</span>
            </div>
          )}

          {isRecurring && (
            <div className="grid gap-2">
              <Label>Окончание</Label>
              <div className="flex items-center gap-2">
                <Controller
                  control={control}
                  name="endType"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="never">Никогда</SelectItem>
                        <SelectItem value="afterN">После N раз</SelectItem>
                        <SelectItem value="until">До даты</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
                {endType === 'afterN' && (
                  <Input type="number" min={1} className="w-24" placeholder="N" {...register('endN')} />
                )}
                {endType === 'until' && (
                  <Input type="date" className="w-44" {...register('endUntil')} />
                )}
              </div>
            </div>
          )}

          {isRecurring && (
            <div className="grid gap-2 rounded-md border p-3">
              <Label className="text-sm font-medium">Доставка</Label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4" {...register('businessDaysOnly')} />
                Только по будням (сб/вс → понедельник)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  {...register('quietEnabled')}
                  onChange={(e) => {
                    setValue('quietEnabled', e.target.checked);
                    if (e.target.checked) {
                      if (!getValues('quietFrom')) setValue('quietFrom', QUIET_HOURS_DEFAULT.from);
                      if (!getValues('quietTo')) setValue('quietTo', QUIET_HOURS_DEFAULT.to);
                      if (!getValues('quietDefer')) setValue('quietDefer', QUIET_HOURS_DEFAULT.deferTo);
                    }
                  }}
                />
                Тихие часы (не беспокоить ночью)
              </label>
              {quietEnabled && (
                <div className="flex flex-wrap items-center gap-2 pl-6 text-sm">
                  <span className="text-muted-foreground">с</span>
                  <Input type="time" className="w-28" {...register('quietFrom')} />
                  <span className="text-muted-foreground">до</span>
                  <Input type="time" className="w-28" {...register('quietTo')} />
                  <span className="text-muted-foreground">→ перенести на</span>
                  <Input type="time" className="w-28" {...register('quietDefer')} />
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Применяется к каждому срабатыванию повтора. Тихое окно может пересекать полночь.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Приоритет</Label>
              <Controller
                control={control}
                name="priority"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">Обычный</SelectItem>
                      <SelectItem value="high">Важный</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" className="h-4 w-4" {...register('silent')} />
              Без звука
            </label>
          </div>

          {preview.valid && (
            <div className="grid gap-1 rounded-md border bg-muted/30 p-3">
              <Label className="text-sm font-medium">Ближайшие срабатывания</Label>
              {preview.fires.length > 0 ? (
                <ul className="text-sm text-muted-foreground">
                  {preview.fires.map((iso) => (
                    <li key={iso}>{formatMoscowInstant(iso)}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Нет будущих срабатываний (момент в прошлом или серия завершена).
                </p>
              )}
            </div>
          )}

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
