import { Plus } from 'lucide-react';
import { requireUser } from '@/lib/auth/current-user';
import { listProjects } from '@/lib/services/secrets';
import { secretsConfigured } from '@/lib/secrets/crypto';
import { Button } from '@/components/ui/button';
import { SecretProjectDialog } from '@/components/app/secret-project-dialog';
import { SecretProjectsList } from '@/components/app/secret-projects-list';

export default async function SecretsPage() {
  const user = await requireUser();
  const projects = await listProjects(user);
  const configured = secretsConfigured();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Секреты</h1>
          <p className="text-sm text-muted-foreground">Зашифрованное хранилище ключей проектов</p>
        </div>
        <SecretProjectDialog
          trigger={
            <Button>
              <Plus className="mr-1 h-4 w-4" /> Новый проект
            </Button>
          }
        />
      </div>

      {!configured && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
          <b>SECRETS_MASTER_KEY не задан.</b> Проекты создавать можно, но шифрование и выдача секретов
          не заработают, пока мастер-ключ не добавлен в окружение сервера. См. docs/secrets-manager.md.
        </div>
      )}

      <SecretProjectsList projects={projects} />
    </div>
  );
}
