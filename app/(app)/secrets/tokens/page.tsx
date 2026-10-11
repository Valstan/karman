import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireSecretsUser } from '@/lib/auth/current-user';
import { listTokenInventory } from '@/lib/services/secrets';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';

/**
 * Инвентарь токенов (S1 дорожной карты доступов): все комнаты хранилища —
 * что живо, что протухло. Только владелец (requireSecretsUser: суперпользователь
 * + 2FA). Назначение — видеть потерянные токены (last_used = «никогда») до того,
 * как они станут проблемой класса «комната, которой токен не нужен».
 */
export default async function SecretTokensInventoryPage() {
  await requireSecretsUser();
  const tokens = await listTokenInventory();
  const now = new Date().toISOString();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/secrets"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> К проектам
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Инвентарь токенов</h1>
        <p className="text-sm text-muted-foreground">Все комнаты хранилища: что живо, что протухло.</p>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Комната</TableHead>
              <TableHead>Токен</TableHead>
              <TableHead>Права</TableHead>
              <TableHead>Личность</TableHead>
              <TableHead>Последнее использование</TableHead>
              <TableHead>Истекает</TableHead>
              <TableHead>Статус</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-20 text-center text-muted-foreground">
                  Токенов пока нет.
                </TableCell>
              </TableRow>
            )}
            {tokens.map((t) => {
              const expired = t.expiresAt !== null && t.expiresAt < now;
              return (
                <TableRow key={t.id}>
                  <TableCell>
                    <Link href={`/secrets/${t.projectId}`} className="font-mono text-sm hover:underline">
                      {t.projectSlug}
                    </Link>
                    <div className="text-xs text-muted-foreground">{t.projectName}</div>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm font-medium">{t.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">{t.tokenPrefix}…</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={t.canWrite ? 'default' : 'secondary'}>
                      {t.canWrite ? 'read-write' : 'read-only'}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-sm text-muted-foreground">
                    {t.identityLabel ?? '—'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {t.lastUsedAt ? formatDateTime(t.lastUsedAt) : 'никогда'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {t.expiresAt ? formatDateTime(t.expiresAt) : '—'}
                  </TableCell>
                  <TableCell>
                    {t.revokedAt ? (
                      <Badge variant="secondary">Отозван</Badge>
                    ) : expired ? (
                      <Badge variant="secondary">Истёк</Badge>
                    ) : t.lastUsedAt === null ? (
                      <Badge variant="outline">Ни разу не использован</Badge>
                    ) : (
                      <Badge variant="default">Активен</Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
