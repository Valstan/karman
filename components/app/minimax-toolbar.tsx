'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MinimaxFormDialog } from './minimax-form-dialog';
import { MinimaxImportDialog } from './minimax-import-dialog';
import { MinimaxProjectDialog } from './minimax-activate-dialog';

/**
 * Панель кнопок над разделом «Минимакс» (04.11): «Добавить проект»,
 * «Добавить аккаунт», «Импорт списка аккаунтов» — все три сверху, рядом.
 *
 * Компонент целиком клиентский и сам рисует все три кнопки: серверная страница
 * не передаёт сюда готовые элементы-триггеры (разрыв рендера между сервером и
 * клиентом давал расхождение гидрации).
 */
export function MinimaxToolbar() {
  const [projectOpen, setProjectOpen] = useState(false);

  return (
    <div className="flex flex-nowrap items-center gap-2">
      <Button variant="outline" onClick={() => setProjectOpen(true)}>
        <Plus className="mr-1 h-4 w-4" /> Добавить проект
      </Button>
      <MinimaxFormDialog
        trigger={
          <Button>
            <Plus className="mr-1 h-4 w-4" /> Добавить аккаунт
          </Button>
        }
      />
      <MinimaxImportDialog
        trigger={
          <Button variant="outline">
            <Plus className="mr-1 h-4 w-4" /> Импорт списка аккаунтов
          </Button>
        }
      />
      <MinimaxProjectDialog open={projectOpen} onOpenChange={setProjectOpen} />
    </div>
  );
}
