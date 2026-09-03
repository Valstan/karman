'use client';

import { useFieldArray, useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { saveDocumentFieldsAction } from '@/lib/actions/documents';
import type { DocumentFieldItem } from '@/lib/services/documents';

/**
 * Произвольные поля документа: пары «название → значение», которые человек
 * заводит сам. У паспорта и у полиса ОМС общих реквизитов почти нет, поэтому
 * фиксированной формы под каждый вид документа не существует — есть ядро
 * (название, тип, номер, даты) в колонках и вот этот список сверху.
 *
 * Набор сохраняется целиком: сервер удаляет прежние строки и вставляет
 * присланные. Порядок строк — это порядок в распечатке, поэтому его можно
 * менять стрелками, а не только удалением и добавлением заново.
 */

type FormValues = { fields: { name: string; value: string }[] };

export function DocumentFieldsPanel({
  documentId,
  fields: initial,
}: {
  documentId: number;
  fields: DocumentFieldItem[];
}) {
  const router = useRouter();
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting, isDirty },
  } = useForm<FormValues>({
    defaultValues: { fields: initial.map((f) => ({ name: f.name, value: f.value })) },
  });
  const { fields, append, remove, move } = useFieldArray({ control, name: 'fields' });

  async function onSubmit(values: FormValues) {
    const result = await saveDocumentFieldsAction({ id: documentId, fields: values.fields });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Поля сохранены');
    // Пустые строки сервер выбрасывает — перечитываем с сервера, иначе форма
    // осталась бы показывать то, чего в базе уже нет.
    reset(values);
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Поля документа</CardTitle>
        <CardDescription>
          Всё, что спрашивают по этому документу: серия, кем выдан, код подразделения. Добавьте
          столько строк, сколько нужно — порядок здесь станет порядком в распечатке.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
          {fields.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Полей пока нет. Нажмите «Добавить поле» и впишите название — например, «Серия».
            </p>
          )}
          {fields.map((field, index) => (
            <div key={field.id} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
              <Input
                placeholder="Название поля"
                aria-label={`Название поля ${index + 1}`}
                className="sm:w-64"
                {...register(`fields.${index}.name`)}
              />
              <Input
                placeholder="Значение"
                aria-label={`Значение поля ${index + 1}`}
                className="flex-1"
                {...register(`fields.${index}.value`)}
              />
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  title="Выше"
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  title="Ниже"
                  disabled={index === fields.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  title="Удалить поле"
                  onClick={() => remove(index)}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => append({ name: '', value: '' })}
            >
              <Plus className="mr-1 h-4 w-4" /> Добавить поле
            </Button>
            <Button type="submit" disabled={isSubmitting || !isDirty}>
              {isSubmitting ? 'Сохранение…' : 'Сохранить поля'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
