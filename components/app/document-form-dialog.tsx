'use client';

import { useState, type ReactNode } from 'react';
import { useForm, useFieldArray, useWatch, Controller } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  createDocumentAction,
  saveDocumentFieldsAction,
  updateDocumentAction,
} from '@/lib/actions/documents';
import { DOCUMENT_TEMPLATES, templateById } from '@/lib/documents/templates';
import type { DocumentCategoryOption } from '@/lib/services/documents';

/**
 * Форма документа. При СОЗДАНИИ человек выбирает вид («Паспорт РФ», «СНИЛС»,
 * «Телефоны и почта»…), и форма тут же раскладывает поля этого вида — с
 * возможностью вписать значения сразу, удалить лишнее и добавить своё поле
 * с названием. Так документ заводится за один заход, а не «создать, потом
 * открыть, потом заполнить». Шаблон после создания нигде не хранится: поля —
 * обычные строки, их можно переименовать на экране документа.
 *
 * При РЕДАКТИРОВАНИИ здесь только ядро (название, категория, номер, даты, кем
 * выдан): поля правятся на экране документа, где их может быть два десятка.
 */

type FieldRow = { name: string; value: string };

type FormValues = {
  title: string;
  documentType: string;
  documentNumber: string;
  issueDate: string;
  expiryDate: string;
  issuingAuthority: string;
  isActive: boolean;
  categoryId: string;
  templateId: string;
  fields: FieldRow[];
};

export type DocumentCoreValues = {
  id: number;
  title: string;
  documentType: string;
  documentNumber: string;
  issueDate: string | null;
  expiryDate: string | null;
  // null допускается, хотя колонка NOT NULL: список документов объявляет это
  // поле как `string | null`, и сузить тип здесь означало бы приведение в месте
  // вызова — то есть ложь о данных ради удобства формы.
  issuingAuthority: string | null;
  isActive: boolean;
  categoryId: number;
};

function defaults(doc?: DocumentCoreValues): FormValues {
  return {
    title: doc?.title ?? '',
    documentType: doc?.documentType ?? '',
    documentNumber: doc?.documentNumber ?? '',
    issueDate: doc?.issueDate ?? '',
    expiryDate: doc?.expiryDate ?? '',
    issuingAuthority: doc?.issuingAuthority ?? '',
    isActive: doc?.isActive ?? true,
    categoryId: doc ? String(doc.categoryId) : '',
    templateId: '',
    fields: [],
  };
}

/** Категория по имени из шаблона; нет такой — «Прочее»; нет и её — первая. */
function categoryFor(name: string, categories: DocumentCategoryOption[]): string {
  const exact = categories.find((c) => c.name === name);
  const other = categories.find((c) => c.name === 'Прочее');
  const pick = exact ?? other ?? categories[0];
  return pick ? String(pick.id) : '';
}

export function DocumentFormDialog({
  trigger,
  categories,
  document,
  onSaved,
}: {
  trigger: ReactNode;
  categories: DocumentCategoryOption[];
  document?: DocumentCoreValues;
  /** Куда идти после создания; по умолчанию — на экран нового документа. */
  onSaved?: (id: number) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const isEdit = Boolean(document);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setValue,
    formState: { isSubmitting },
  } = useForm<FormValues>({ defaultValues: defaults(document) });
  const { fields, append, remove, replace } = useFieldArray({ control, name: 'fields' });

  // useWatch, а не watch(): watch() React Compiler не умеет мемоизировать.
  const templateId = useWatch({ control, name: 'templateId' });
  const template = templateById(templateId);
  const coreless = template?.coreless === true;

  async function onSubmit(values: FormValues) {
    if (!values.categoryId) {
      toast.error('Выберите категорию');
      return;
    }
    const payload = {
      title: values.title,
      documentType: values.documentType,
      documentNumber: values.documentNumber,
      issueDate: values.issueDate === '' ? null : values.issueDate,
      expiryDate: values.expiryDate === '' ? null : values.expiryDate,
      issuingAuthority: values.issuingAuthority,
      isActive: values.isActive,
      categoryId: Number(values.categoryId),
    };

    if (isEdit && document) {
      const result = await updateDocumentAction({ id: document.id, ...payload });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Документ сохранён');
      setOpen(false);
      router.refresh();
      return;
    }

    const result = await createDocumentAction(payload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    const id = result.data!.id;

    // Поля ложатся ПОСЛЕ создания, отдельным действием: документ уже
    // существует, и провал этого шага не должен отменять его создание — поля
    // человек допишет руками, а потерянный документ пришлось бы заводить заново.
    // Строки с пустым названием сервер выбрасывает; пустые значения остаются —
    // это «ещё не вписал», и в распечатку они всё равно не попадают.
    const rows = values.fields.filter((f) => f.name.trim() !== '');
    if (rows.length > 0) {
      const fieldsResult = await saveDocumentFieldsAction({ id, fields: rows });
      if (!fieldsResult.ok) toast.error(`Документ создан, но поля не легли: ${fieldsResult.error}`);
    }

    toast.success('Документ создан');
    setOpen(false);
    reset(defaults());
    if (onSaved) onSaved(id);
    else router.push(`/documents/${id}`);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset(defaults(document));
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Редактировать документ' : 'Новый документ'}</DialogTitle>
          {!isEdit && (
            <DialogDescription>
              Выберите вид — поля разложатся сами. Файлы (сканы) добавите на экране документа.
            </DialogDescription>
          )}
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          {!isEdit && (
            <div className="grid gap-2">
              <Label>Вид документа</Label>
              <Controller
                control={control}
                name="templateId"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(next) => {
                      field.onChange(next);
                      const t = templateById(next);
                      if (!t) return;
                      // Вид подставляет название, тип, категорию и раскладывает
                      // поля. Значения уже вписанных полей при смене вида
                      // теряются — поэтому смена вида и стоит первой в форме.
                      setValue('documentType', t.documentType);
                      setValue('title', t.documentType === '' ? '' : t.label, { shouldDirty: true });
                      setValue('categoryId', categoryFor(t.category, categories));
                      replace(t.fields.map((name) => ({ name, value: '' })));
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Выберите вид" />
                    </SelectTrigger>
                    <SelectContent>
                      {DOCUMENT_TEMPLATES.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="title">Название</Label>
            <Input id="title" required placeholder="Паспорт РФ, СНИЛС, Диплом…" {...register('title')} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Категория</Label>
              <Controller
                control={control}
                name="categoryId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Выберите" />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((category) => (
                        <SelectItem key={category.id} value={String(category.id)}>
                          {category.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="documentType">Тип (коротко)</Label>
              <Input id="documentType" placeholder="Паспорт, СНИЛС…" maxLength={20} {...register('documentType')} />
            </div>
          </div>

          {!coreless && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="documentNumber">Номер</Label>
                  <Input id="documentNumber" {...register('documentNumber')} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="issuingAuthority">Кем выдан</Label>
                  <Input id="issuingAuthority" {...register('issuingAuthority')} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="issueDate">Дата выдачи</Label>
                  <Input id="issueDate" type="date" {...register('issueDate')} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="expiryDate">Действует до</Label>
                  <Input id="expiryDate" type="date" {...register('expiryDate')} />
                </div>
              </div>
            </>
          )}

          {!isEdit && (
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>Поля документа</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => append({ name: '', value: '' })}
                >
                  <Plus className="mr-1 h-4 w-4" /> Своё поле
                </Button>
              </div>
              {fields.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Выберите вид документа или добавьте своё поле — название и значение.
                </p>
              )}
              {fields.map((row, index) => (
                <div key={row.id} className="flex items-center gap-2">
                  <Input
                    placeholder="Название"
                    aria-label={`Название поля ${index + 1}`}
                    className="w-2/5"
                    {...register(`fields.${index}.name`)}
                  />
                  <Input
                    placeholder="Значение"
                    aria-label={`Значение поля ${index + 1}`}
                    className="flex-1"
                    {...register(`fields.${index}.value`)}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    title="Убрать поле"
                    onClick={() => remove(index)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" {...register('isActive')} /> Действующий
          </label>
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
