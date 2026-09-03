import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireSecretsUser } from '@/lib/auth/current-user';
import { listIdentities, listIssuers } from '@/lib/services/passport';
import { listProjects } from '@/lib/services/secrets';
import { PassportIdentitiesPanel } from '@/components/app/passport-identities-panel';

/**
 * Реестр личностей — раздел уровня `/secrets`, а не отдельной комнаты: личности
 * живут поперёк комнат, и на странице одной комнаты половина реестра была бы
 * не видна.
 *
 * Соседство с `/secrets/[id]` намеренное и безопасное: статический сегмент
 * маршрута выигрывает у динамического, а `[id]` и так принимает только целые
 * числа (иначе `notFound`). Комнаты с идентификатором `identities` не бывает.
 */
export default async function PassportIdentitiesPage() {
  const user = await requireSecretsUser();
  const [identities, issuers, projects] = await Promise.all([
    listIdentities(user),
    listIssuers(),
    listProjects(user),
  ]);
  const rooms = projects.map((p) => ({ id: p.id, name: p.name, slug: p.slug }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/secrets"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> К проектам
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Реестр личностей</h1>
        <p className="text-sm text-muted-foreground">
          Кто может войти в комнаты без токена, предъявив подписанное удостоверение
        </p>
      </div>

      <PassportIdentitiesPanel
        identities={identities}
        issuers={issuers}
        rooms={rooms}
        canManage={user.isSuperuser}
      />
    </div>
  );
}
