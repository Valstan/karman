'use client';

import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { createFamilyPersonAction, updateFamilyPersonAction } from '@/lib/actions/family';
import type { TreePerson } from '@/lib/family/kinship';

/**
 * Карточка человека древа. Одна форма на создание и правку: поля те же,
 * разница только в том, куда уходит результат. При создании «от кого-то»
 * (кнопки «родителя», «ребёнка», «супруга» на выбранном узле) связь пишется
 * тем же действием — человек появляется в древе сразу на своём месте.
 */

export type PersonFormValues = {
  lastName: string;
  firstName: string;
  middleName: string;
  maidenName: string;
  nickname: string;
  sex: 'm' | 'f' | '';
  born: string;
  birthPlace: string;
  died: string;
  deathPlace: string;
  residence: string;
  occupation: string;
  nationality: string;
  surnameMeaning: string;
  notes: string;
  holder: string;
  isSelf: boolean;
};

export type PersonLink = { anchorId: number; as: 'parent' | 'child' | 'spouse' };

const EMPTY: PersonFormValues = {
  lastName: '',
  firstName: '',
  middleName: '',
  maidenName: '',
  nickname: '',
  sex: '',
  born: '',
  birthPlace: '',
  died: '',
  deathPlace: '',
  residence: '',
  occupation: '',
  nationality: '',
  surnameMeaning: '',
  notes: '',
  holder: '',
  isSelf: false,
};

function fromPerson(p: TreePerson): PersonFormValues {
  return {
    lastName: p.lastName,
    firstName: p.firstName,
    middleName: p.middleName,
    maidenName: p.maidenName,
    nickname: p.nickname,
    sex: p.sex,
    born: p.born,
    birthPlace: p.birthPlace,
    died: p.died,
    deathPlace: p.deathPlace,
    residence: p.residence,
    occupation: p.occupation,
    nationality: p.nationality,
    surnameMeaning: p.surnameMeaning,
    notes: p.notes,
    holder: p.holder,
    isSelf: p.isSelf,
  };
}

const LINK_TITLE: Record<PersonLink['as'], string> = {
  parent: 'Новый родитель',
  child: 'Новый ребёнок',
  spouse: 'Новый супруг / супруга',
};

export function FamilyPersonDialog({
  open,
  onOpenChange,
  person,
  link,
  anchorName,
  holders,
  defaults,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Правим этого человека; нет — создаём нового. */
  person?: TreePerson;
  /** Кем новый приходится уже существующему (только при создании). */
  link?: PersonLink;
  anchorName?: string;
  /** Уже встречающиеся «чьи документы» — подсказка для привязки. */
  holders: string[];
  /** Подстановки для нового человека (фамилия от родителя и т. п.). */
  defaults?: Partial<PersonFormValues>;
  onSaved?: (id: number) => void;
}) {
  const router = useRouter();
  const isEdit = Boolean(person);
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<PersonFormValues>({ defaultValues: EMPTY });

  // Форма живёт дольше одного открытия: значения подставляются при каждом.
  useEffect(() => {
    if (open) reset(person ? fromPerson(person) : { ...EMPTY, ...defaults });
  }, [open, person, defaults, reset]);

  async function onSubmit(values: PersonFormValues) {
    const result = person
      ? await updateFamilyPersonAction({ id: person.id, person: values })
      : await createFamilyPersonAction({ person: values, link });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(person ? 'Сохранено' : 'Человек добавлен');
    onOpenChange(false);
    router.refresh();
    const id = person ? person.id : (result as { data?: { id: number } }).data?.id;
    if (id !== undefined) onSaved?.(id);
  }

  const title = person ? 'Человек в древе' : link ? LINK_TITLE[link.as] : 'Новый человек';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {link && anchorName
              ? `Будет связан с: ${anchorName}. `
              : ''}
            Даты можно писать как знаете: «1952», «около 1900», «12.03.1985». Пустое — не страшно,
            допишете потом.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Фамилия" id="lastName">
              <Input id="lastName" {...register('lastName')} />
            </Field>
            <Field label="Имя" id="firstName">
              <Input id="firstName" {...register('firstName')} />
            </Field>
            <Field label="Отчество" id="middleName">
              <Input id="middleName" {...register('middleName')} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Девичья фамилия" id="maidenName">
              <Input id="maidenName" {...register('maidenName')} />
            </Field>
            <Field label="Как зовут в семье" id="nickname">
              <Input id="nickname" placeholder="бабушка Люся" {...register('nickname')} />
            </Field>
            <Field label="Пол" id="sex">
              <Controller
                control={control}
                name="sex"
                render={({ field }) => (
                  <Select value={field.value || 'none'} onValueChange={(v) => field.onChange(v === 'none' ? '' : v)}>
                    <SelectTrigger id="sex">
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Не указан</SelectItem>
                      <SelectItem value="m">Мужской</SelectItem>
                      <SelectItem value="f">Женский</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Родился / родилась" id="born">
              <Input id="born" placeholder="1952 или 12.03.1985" {...register('born')} />
            </Field>
            <Field label="Место рождения" id="birthPlace">
              <Input id="birthPlace" placeholder="с. Калинино, Малмыжский район" {...register('birthPlace')} />
            </Field>
            <Field label="Умер / умерла" id="died">
              <Input id="died" {...register('died')} />
            </Field>
            <Field label="Место смерти" id="deathPlace">
              <Input id="deathPlace" {...register('deathPlace')} />
            </Field>
          </div>
          <Field label="Где жил(а), территория проживания" id="residence">
            <Input id="residence" placeholder="г. Киров; с. Калинино" {...register('residence')} />
          </Field>
          <Field label="Род занятий, профессия, где работал(а)" id="occupation">
            <Textarea id="occupation" rows={2} {...register('occupation')} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Национальность" id="nationality">
              <Input id="nationality" {...register('nationality')} />
            </Field>
            <Field label="Чей документ (для перехода к документам)" id="holder">
              <Input id="holder" list="family-holders" placeholder="как в поле «чей документ»" {...register('holder')} />
              <datalist id="family-holders">
                {holders.map((h) => (
                  <option key={h} value={h} />
                ))}
              </datalist>
            </Field>
          </div>
          <Field label="Значение фамилии" id="surnameMeaning">
            <Textarea id="surnameMeaning" rows={2} {...register('surnameMeaning')} />
          </Field>
          <Field label="Заметки: истории, что помним" id="notes">
            <Textarea id="notes" rows={3} {...register('notes')} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...register('isSelf')} />
            Это я — от этого человека считается родство («дядя», «прабабушка»)
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Сохранение…' : isEdit ? 'Сохранить' : 'Добавить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
