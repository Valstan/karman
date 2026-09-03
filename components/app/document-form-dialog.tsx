'use client';

import { useState, type ReactNode } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useRouter } from 'next/navigation';
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
 * Ядро документа: название, категория, тип, номер, даты, кем выдан. Всё
 * остальное — произвольные поля и файлы — живёт на экране самого документа
 * (`/documents/[id]`): их там может быть по два десятка, и в диалог они не
 * помещаются ни физически, ни по смыслу.
 *
 * При СОЗДАНИИ здесь же выбирается шаблон: он не ограничивает документ, а лишь
 * заранее раскладывает пустые поля с названиями («Серия», «Код подразделения»),
 * чтобы человек не вспоминал, что вообще спрашивают по паспорту. После создания
 * шаблон нигде не хранится — поля обычные, их можно удалить и переименовать.
 */

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
    templateId: 'custom',
  };
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

    // Поля шаблона раскладываются ПОСЛЕ создания, отдельным действием: документ
    // уже существует, и провал этого шага не должен отменять его создание —
    // поля человек допишет руками, а потерянный документ пришлось бы заводить
    // заново вместе со всеми файлами.
    const template = templateById(values.templateId);
    if (template && template.fields.length > 0) {
      const fieldsResult = await saveDocumentFieldsAction({
        id,
        fields: template.fields.map((name) => ({ name, value: '' })),
      });
      if (!fieldsResult.ok) toast.error(`Документ создан, но поля шаблона не легли: ${fieldsResult.error}`);
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Редактировать документ' : 'Новый документ'}</DialogTitle>
          {!isEdit && (
            <DialogDescription>
              Файлы и остальные реквизиты добавите на экране документа сразу после создания.
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
                      // Тип и название подставляются из шаблона, но только если
                      // человек ещё ничего не вписал: перезаписывать введённое
                      // выбором из списка — худший вид «помощи».
                      const template = templateById(next);
                      if (template && template.documentType !== '') {
                        setValue('documentType', template.documentType);
                        setValue('title', template.label, { shouldDirty: true });
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Выберите вид" />
                    </SelectTrigger>
                    <SelectContent>
                      {DOCUMENT_TEMPLATES.map((template) => (
                        <SelectItem key={template.id} value={template.id}>
                          {template.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <p className="text-xs text-muted-foreground">
                Шаблон только разложит пустые поля с названиями. Их можно удалить, переименовать
                и дописать свои.
              </p>
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="title">Название</Label>
            <Input id="title" required {...register('title')} />
          </div>
          <div className="grid gap-2">
            <Label>Категория</Label>
            <Controller
              control={control}
              name="categoryId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Выберите категорию" />
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
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="documentType">Тип</Label>
              <Input id="documentType" placeholder="Паспорт, СНИЛС…" {...register('documentType')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="documentNumber">Номер</Label>
              <Input id="documentNumber" {...register('documentNumber')} />
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
          <div className="grid gap-2">
            <Label htmlFor="issuingAuthority">Кем выдан</Label>
            <Input id="issuingAuthority" {...register('issuingAuthority')} />
          </div>
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
