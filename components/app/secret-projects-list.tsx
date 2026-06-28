'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Pencil, Trash2, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SecretProjectDialog } from './secret-project-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { deleteProjectAction } from '@/lib/actions/secrets';
import { formatDate } from '@/lib/format';
import type { SecretProjectListItem } from '@/lib/services/secrets';

export function SecretProjectsList({ projects }: { projects: SecretProjectListItem[] }) {
  const router = useRouter();

  async function remove(id: number) {
    const result = await deleteProjectAction(id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success('Проект удалён');
    router.refresh();
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Проект</TableHead>
            <TableHead>Слаг</TableHead>
            <TableHead className="text-right">Секретов</TableHead>
            <TableHead className="text-right">Токенов</TableHead>
            <TableHead>Создан</TableHead>
            <TableHead className="text-right">Действия</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                Проектов пока нет.
              </TableCell>
            </TableRow>
          )}
          {projects.map((p) => (
            <TableRow key={p.id}>
              <TableCell className="font-medium">
                <Link href={`/secrets/${p.id}`} className="inline-flex items-center gap-2 hover:underline">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  {p.name}
                </Link>
              </TableCell>
              <TableCell className="font-mono text-sm text-muted-foreground">{p.slug}</TableCell>
              <TableCell className="text-right">{p.itemCount}</TableCell>
              <TableCell className="text-right">{p.tokenCount}</TableCell>
              <TableCell>{formatDate(p.createdAt)}</TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  <SecretProjectDialog
                    project={{ id: p.id, name: p.name, slug: p.slug }}
                    trigger={
                      <Button size="icon" variant="ghost" title="Редактировать">
                        <Pencil className="h-4 w-4" />
                      </Button>
                    }
                  />
                  <ConfirmDialog
                    title="Удалить проект?"
                    description="Будут удалены все секреты и токены проекта. Действие необратимо."
                    onConfirm={() => remove(p.id)}
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
  );
}
