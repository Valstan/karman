'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createProjectAction } from '@/lib/actions/accounts';
import { copyAccountSecret, type ActivateKind } from './minimax-activation';
import type { AccountListItem, ProjectListItem } from '@/lib/services/accounts';

const NONE = '__none__';

/**
 * Диалог активации: владелец СПРАШИВАЕТ, по какому проекту активируется
 * аккаунт, — ДО того, как аккаунт погаснет (04.11: «все таки, спрашивал он,
 * сразу, до того, как погасится»).
 *
 * Поэтому диалог открывается ДО копирования: сначала ответ, потом буфер
 * обмена, потом активация. Отмена в диалоге не копирует и не гасит.
 *
 * Порядок внутри: сначала копирование, потом активация. Если копирование не
 * удалось — аккаунт не гасим (иначе владелец потерял бы аккаунт зря).
 *
 * Проект по умолчанию — тот, что был при прошлой активации этого аккаунта,
 * чтобы не выбирать его заново каждый раз.
 *
 * Состояние живёт ВНУТРИ содержимого диалога: то содержимое размонтируется при
 * закрытии, поэтому каждое открытие начинается с чистых полей (без сброса
 * состояния в эффекте — так линтер и требует).
 */
export function MinimaxActivateDialog({
  open,
  onOpenChange,
  account,
  kind,
  projects,
  onActivated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: AccountListItem | null;
  kind: ActivateKind;
  projects: ProjectListItem[];
  /** Активация состоялась — раздел запоминает выбранный проект. */
  onActivated?: (accountId: number, projectId: number | null) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && account ? (
        <DialogContent>
          <ActivateForm
            account={account}
            kind={kind}
            projects={projects}
            onOpenChange={onOpenChange}
            onActivated={onActivated}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function ActivateForm({
  account,
  kind,
  projects,
  onOpenChange,
  onActivated,
}: {
  account: AccountListItem;
  kind: ActivateKind;
  projects: ProjectListItem[];
  onOpenChange: (open: boolean) => void;
  onActivated?: (accountId: number, projectId: number | null) => void;
}) {
  const router = useRouter();
  const [project, setProject] = useState<string>(
    account.projectId === null ? NONE : String(account.projectId),
  );
  const [tokens, setTokens] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setBusy(true);
    try {
      const raw = tokens.trim();
      const projectId = project === NONE ? null : Number(project);
      const tokensValue = raw === '' ? undefined : Number(raw);

      const outcome = await copyAccountSecret(account, kind, projectId, tokensValue);
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }

      toast.success(
        kind === 'email'
          ? 'Почта скопирована — аккаунт погаснет на 24 часа'
          : 'Пароль скопирован — аккаунт погаснет на 24 часа',
      );
      onActivated?.(account.id, projectId);
      onOpenChange(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Активация аккаунта</DialogTitle>
        <DialogDescription>
          «{account.title || account.email}» — на какой проект зачислить эту активацию? Аккаунт
          погаснет на 24 часа с момента активации.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="activate-project">Проект</Label>
          <Select value={project} onValueChange={setProject}>
            <SelectTrigger id="activate-project">
              <SelectValue placeholder="Без проекта" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Без проекта</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="activate-tokens">Токены за активацию (необязательно)</Label>
          <Input
            id="activate-tokens"
            type="number"
            min={0}
            inputMode="numeric"
            placeholder="0"
            value={tokens}
            onChange={(e) => setTokens(e.target.value)}
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
          Отмена
        </Button>
        <Button onClick={onSubmit} disabled={busy}>
          {busy ? 'Сохраняю…' : kind === 'email' ? 'Скопировать почту' : 'Скопировать пароль'}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Диалог добавления проекта: владелец заводит справочник названий
 * («Матрица РМЗ», «Сабантуй», «Казанская») — по одному имени, без отдельной
 * страницы.
 *
 * Состояние — внутри содержимого (размонтируется при закрытии), поэтому поле
 * каждый раз открывается пустым.
 */
export function MinimaxProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent>
          <ProjectForm onOpenChange={onOpenChange} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function ProjectForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('Укажите название проекта');
      return;
    }
    setBusy(true);
    try {
      const result = await createProjectAction({ name: trimmed });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`Проект «${trimmed}» добавлен`);
      onOpenChange(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Новый проект</DialogTitle>
        <DialogDescription>
          Название проекта, на который потом зачисляются активации аккаунтов.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1">
        <Label htmlFor="project-name">Название</Label>
        <Input
          id="project-name"
          value={name}
          placeholder="Матрица РМЗ, Сабантуй, Казанская…"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onSubmit();
          }}
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
          Отмена
        </Button>
        <Button onClick={onSubmit} disabled={busy}>
          {busy ? 'Добавляю…' : 'Добавить'}
        </Button>
      </DialogFooter>
    </>
  );
}
