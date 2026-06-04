'use client';

import { useState, type ReactNode } from 'react';
import { useForm, Controller } from 'react-hook-form';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createDocumentAction, updateDocumentAction } from '@/lib/actions/documents';
import type { DocumentListItem, DocumentCategoryOption } from '@/lib/services/documents';

const FILE_ACCEPT = '.jpg,.jpeg,.png,.webp,.pdf';

const FILE_SLOTS = [
  { slot: 'front', label: 'Лицевая сторона' },
  { slot: 'back', label: 'Оборотная сторона' },
  { slot: 'additional', label: 'Доп. файл' },
] as const;

type FileSlot = (typeof FILE_SLOTS)[number]['slot'];

type FormValues = {
  title: string;
  documentType: string;
  documentNumber: string;
  issueDate: string;
  expiryDate: string;
  issuingAuthority: string;
  isActive: boolean;
  categoryId: string;
};

function defaults(doc?: DocumentListItem): FormValues {
  return {
    title: doc?.title ?? '',
    documentType: doc?.documentType ?? '',
    documentNumber: doc?.documentNumber ?? '',
    issueDate: doc?.issueDate ?? '',
    expiryDate: doc?.expiryDate ?? '',
    issuingAuthority: doc?.issuingAuthority ?? '',
    isActive: doc?.isActive ?? true,
    categoryId: doc ? String(doc.categoryId) : '',
  };
}

function hasExistingFile(doc: DocumentListItem | undefined, slot: FileSlot): boolean {
  if (!doc) return false;
  if (slot === 'front') return doc.hasFront;
  if (slot === 'back') return doc.hasBack;
  return doc.hasAdditional;
}

async function uploadFile(docId: number, slot: FileSlot, file: File): Promise<string | null> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`/api/documents/${docId}/file/${slot}`, { method: 'POST', body: fd });
  if (res.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.message ?? 'Не удалось загрузить файл';
}

async function removeFile(docId: number, slot: FileSlot): Promise<string | null> {
  const res = await fetch(`/api/documents/${docId}/file/${slot}`, { method: 'DELETE' });
  if (res.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.message ?? 'Не удалось удалить файл';
}

export function DocumentFormDialog({
  trigger,
  categories,
  document,
}: {
  trigger: ReactNode;
  categories: DocumentCategoryOption[];
  document?: DocumentListItem;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<Record<FileSlot, File | null>>({
    front: null,
    back: null,
    additional: null,
  });
  const [removed, setRemoved] = useState<Record<FileSlot, boolean>>({
    front: false,
    back: false,
    additional: false,
  });
  const isEdit = Boolean(document);

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { isSubmitting },
  } = useForm<FormValues>({ defaultValues: defaults(document) });

  function resetFileState() {
    setFiles({ front: null, back: null, additional: null });
    setRemoved({ front: false, back: false, additional: false });
  }

  async function syncFiles(docId: number): Promise<string[]> {
    const errors: string[] = [];
    for (const { slot } of FILE_SLOTS) {
      const file = files[slot];
      if (file) {
        const err = await uploadFile(docId, slot, file);
        if (err) errors.push(err);
      } else if (removed[slot] && hasExistingFile(document, slot)) {
        const err = await removeFile(docId, slot);
        if (err) errors.push(err);
      }
    }
    return errors;
  }

  async function onSubmit(values: FormValues) {
    if (!values.categoryId) {
      toast.error('Выберите категорию');
      return;
    }

    let docId = document?.id;
    if (isEdit) {
      const result = await updateDocumentAction({ id: document!.id, ...values });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
    } else {
      const result = await createDocumentAction(values);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      docId = result.data?.id;
    }

    if (docId) {
      const fileErrors = await syncFiles(docId);
      if (fileErrors.length > 0) {
        toast.error(fileErrors[0]);
        setOpen(false);
        router.refresh();
        return;
      }
    }

    toast.success(isEdit ? 'Документ обновлён' : 'Документ добавлен');
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          reset(defaults(document));
          resetFileState();
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Редактировать документ' : 'Новый документ'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
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
            <input type="checkbox" className="size-4" {...register('isActive')} />
            Действующий
          </label>

          <div className="grid gap-3 rounded-md border p-3">
            <span className="text-sm font-medium">Сканы (JPG, PNG, WEBP, PDF · до 10 МБ)</span>
            {FILE_SLOTS.map(({ slot, label }) => {
              const existing = hasExistingFile(document, slot) && !removed[slot];
              const selected = files[slot];
              return (
                <div key={slot} className="grid gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor={`file-${slot}`} className="text-sm">
                      {label}
                    </Label>
                    {existing && !selected && (
                      <div className="flex items-center gap-2 text-xs">
                        <a
                          href={`/api/documents/${document!.id}/file/${slot}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline"
                        >
                          Открыть
                        </a>
                        <button
                          type="button"
                          className="text-destructive underline"
                          onClick={() => setRemoved((r) => ({ ...r, [slot]: true }))}
                        >
                          Удалить
                        </button>
                      </div>
                    )}
                    {existing && removed[slot] && (
                      <span className="text-xs text-muted-foreground">будет удалён</span>
                    )}
                  </div>
                  <Input
                    id={`file-${slot}`}
                    type="file"
                    accept={FILE_ACCEPT}
                    onChange={(e) => {
                      const file = e.target.files?.[0] ?? null;
                      setFiles((f) => ({ ...f, [slot]: file }));
                      if (file) setRemoved((r) => ({ ...r, [slot]: false }));
                    }}
                  />
                </div>
              );
            })}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Сохранение…' : isEdit ? 'Сохранить' : 'Добавить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
