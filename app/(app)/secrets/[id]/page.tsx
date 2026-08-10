import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireSecretsUser } from '@/lib/auth/current-user';
import { getProjectDetail, listCards, listGrants, listProjects } from '@/lib/services/secrets';
import { listBootstraps } from '@/lib/services/bootstrap';
import { SecretCardsPanel } from '@/components/app/secret-cards-panel';
import { SecretItemsPanel } from '@/components/app/secret-items-panel';
import { SecretTokensPanel } from '@/components/app/secret-tokens-panel';
import { SecretGrantsPanel } from '@/components/app/secret-grants-panel';
import { SecretBootstrapPanel } from '@/components/app/secret-bootstrap-panel';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDate } from '@/lib/format';

export default async function SecretProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSecretsUser();
  const { id } = await params;
  const projectId = Number(id);
  if (!Number.isInteger(projectId) || projectId <= 0) notFound();

  const detail = await getProjectDetail(user, projectId);
  if (!detail) notFound();
  const cards = (await listCards(user, projectId)) ?? [];
  const grants = (await listGrants(user, projectId)) ?? { issued: [], received: [] };
  const rooms = (await listProjects(user)).map((p) => ({ id: p.id, name: p.name, slug: p.slug }));
  const bootstraps = (await listBootstraps(user, projectId)) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/secrets"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> К проектам
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{detail.project.name}</h1>
        <p className="font-mono text-sm text-muted-foreground">{detail.project.slug}</p>
      </div>

      <SecretCardsPanel projectId={detail.project.id} cards={cards} items={detail.items} />
      <SecretItemsPanel projectId={detail.project.id} items={detail.items} />
      <SecretTokensPanel projectId={detail.project.id} tokens={detail.tokens} />
      <SecretBootstrapPanel projectId={detail.project.id} bootstraps={bootstraps} />
      <SecretGrantsPanel
        projectId={detail.project.id}
        grants={grants}
        items={detail.items}
        rooms={rooms}
      />

      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Аудит доступа</h2>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Когда</TableHead>
                <TableHead>Кто</TableHead>
                <TableHead>Действие</TableHead>
                <TableHead>Детали</TableHead>
                <TableHead>IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.audit.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="h-16 text-center text-muted-foreground">
                    Обращений пока не было.
                  </TableCell>
                </TableRow>
              )}
              {detail.audit.map((a, i) => (
                <TableRow key={i}>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(a.at)}</TableCell>
                  {/* Строки до миграции 0007 актора не несут — «—» здесь значит
                      «неизвестно», а не «никто» (ADR-0012 §6). */}
                  <TableCell className="font-mono text-sm">{a.actor ?? '—'}</TableCell>
                  <TableCell className="font-mono text-sm">{a.action}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{a.detail ?? '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{a.ip ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
