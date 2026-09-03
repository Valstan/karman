import Link from 'next/link';
import { Users } from 'lucide-react';
import { requireUser } from '@/lib/auth/current-user';
import { listMyCircles, visiblePeopleIds } from '@/lib/services/circle';
import { buttonVariants } from '@/components/ui/button';
import { CirclePanel } from '@/components/app/circle-panel';

export default async function CirclePage() {
  const user = await requireUser();
  const [circles, visible] = await Promise.all([listMyCircles(user), visiblePeopleIds(user)]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Круг</h1>
          <p className="text-sm text-muted-foreground">
            Общее пространство родни. Данные открываются только по согласию — и только тем, кто
            согласился сам.
          </p>
        </div>
        {visible.length > 0 && (
          <Link href="/circle/people" className={buttonVariants({ variant: 'outline' })}>
            <Users className="mr-1 h-4 w-4" /> Данные круга ({visible.length + 1})
          </Link>
        )}
      </div>
      <CirclePanel circles={circles} currentUserId={user.id} />
    </div>
  );
}
