import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireUser } from '@/lib/auth/current-user';
import { getFamilyTree } from '@/lib/services/family';
import { FamilyTree } from '@/components/app/family-tree';

/**
 * Древо семьи — вкладка раздела «Документы» (задача владельца 2026-09-21):
 * кто кому приходится, где жил, чем занимался. Люди древа — не аккаунты и не
 * круг, а записи владельца; чужое древо никому не видно.
 */
export default async function FamilyTreePage() {
  const user = await requireUser();
  const data = await getFamilyTree(user);
  const holders = Object.keys(data.documentCounts).filter((h) => h !== '').sort((a, b) => a.localeCompare(b, 'ru'));

  return (
    <div className="flex flex-col gap-6">
      <div className="no-print">
        <Link href="/documents" className="mb-2 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" /> Документы
        </Link>
        <h1 className="text-2xl font-semibold">Древо семьи</h1>
        <p className="text-sm text-muted-foreground">
          ФИО, кто кому приходится, где жили и чем занимались — от самых давних до сегодняшних.
          Нажмите на человека, чтобы добавить ему родителей, детей или супруга. «Печать» выводит
          открытую вкладку — древо или текст.
        </p>
      </div>
      <FamilyTree people={data.people} relations={data.relations} documentCounts={data.documentCounts} holders={holders} />
    </div>
  );
}
