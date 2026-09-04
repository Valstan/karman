'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Users, UserX } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { setCircleSharedAction } from '@/lib/actions/documents';

/** Одна кнопка «В круг» / «Убрать из круга» для экрана документа. */
export function CircleShareToggle({ documentId, shared }: { documentId: number; shared: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      const result = await setCircleSharedAction([documentId], !shared);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(shared ? 'Убрано из круга' : 'Открыто кругу');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button type="button" variant="outline" disabled={busy} onClick={toggle}>
      {shared ? <UserX className="mr-1 h-4 w-4" /> : <Users className="mr-1 h-4 w-4" />}
      {shared ? 'Убрать из круга' : 'В круг'}
    </Button>
  );
}
