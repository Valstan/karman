import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireUser } from '@/lib/auth/current-user';
import { listVisibleDocuments, listVisiblePeople } from '@/lib/services/circle';
import { CircleExportPanel } from '@/components/app/circle-export-panel';

/**
 * Экран выгрузки. Данные приходят сюда уже отфильтрованными по согласиям
 * (`listVisiblePeople` / `listVisibleDocuments` считают круг сами), поэтому
 * клиенту нечего «попросить лишнего»: он выбирает только из того, что ему
 * и так открыто.
 *
 * Дата берётся на сервере и передаётся вниз: сборщик имени файла — чистый
 * модуль, часов в нём нет намеренно.
 */
export default async function CircleExportPage() {
  const user = await requireUser();
  const [people, documents] = await Promise.all([
    listVisiblePeople(user),
    listVisibleDocuments(user),
  ]);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="flex flex-col gap-6">
      <div className="no-print">
        <Link
          href="/circle/people"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> К данным круга
        </Link>
      </div>

      <div className="no-print">
        <h1 className="text-2xl font-semibold">Выгрузка</h1>
        <p className="text-sm text-muted-foreground">
          Отметьте, чьи данные и какие поля забрать. Документы отмечаются отдельно — вместе
          с прикреплёнными файлами или без них.
        </p>
      </div>

      <CircleExportPanel
        people={people.map((p) => ({ userId: p.userId, name: p.name, profile: p.profile }))}
        documents={documents}
        today={today}
      />
    </div>
  );
}
