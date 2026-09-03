'use client';

import { useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { saveProfileAction } from '@/lib/actions/profile';
import { profileFieldGroups, type ProfileValues } from '@/lib/profile/fields';

/**
 * Форма «Мои данные». Поля не перечислены здесь руками, а разворачиваются из
 * `PROFILE_FIELDS` — того же списка, по которому строится выгрузка галочками.
 * Добавленное туда поле появляется и в форме, и в распечатке одновременно;
 * два независимых перечня разъехались бы на первом же добавлении.
 */
export function ProfileForm({ profile }: { profile: ProfileValues }) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting, isDirty },
  } = useForm<ProfileValues>({ defaultValues: profile });

  async function onSubmit(values: ProfileValues) {
    const result = await saveProfileAction(values);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Данные сохранены');
    // reset(values) снимает isDirty: без него кнопка остаётся активной, и
    // человек жмёт «Сохранить» повторно, не понимая, сохранилось ли.
    reset(values);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-6">
      {profileFieldGroups().map(({ group, fields }) => (
        <Card key={group}>
          <CardHeader>
            <CardTitle className="text-base">{group}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {fields.map((field) => (
              <div
                key={field.key}
                className={field.kind === 'multiline' ? 'grid gap-2 sm:col-span-2' : 'grid gap-2'}
              >
                <Label htmlFor={`profile-${field.key}`}>{field.label}</Label>
                {field.kind === 'multiline' ? (
                  <Textarea id={`profile-${field.key}`} rows={2} {...register(field.key)} />
                ) : (
                  <Input
                    id={`profile-${field.key}`}
                    type={field.kind === 'date' ? 'date' : 'text'}
                    {...register(field.key)}
                  />
                )}
                {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
      <div className="flex justify-end">
        <Button type="submit" disabled={isSubmitting || !isDirty}>
          {isSubmitting ? 'Сохранение…' : 'Сохранить'}
        </Button>
      </div>
    </form>
  );
}
