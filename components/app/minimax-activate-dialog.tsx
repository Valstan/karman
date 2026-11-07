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
import {
  WEEKLY_ACTIVATION_LIMIT,
  WEEKLY_ACTIVATION_POINTS,
  pointsForIndex,
} from '@/lib/accounts/weekly';
import { activateAccountOnly, publishMinimaxActivated } from './minimax-activation';
import type { AccountListItem, ProjectListItem } from '@/lib/services/accounts';

const NONE = '__none__';

/**
 * Диалог активации: владелец СПРАШИВАЕТ, по какому проекту активируется
 * аккаунт, какая это по счёту активация в неделе, и сколько на это очков — и
 * только после этого аккаунт гаснет.
 *
 * Заказ владельца 05.11: **гасит аккаунт только явная кнопка «Активировать»**,
 * копирование почты или пароля больше ничего не меняет. Поэтому диалог вызывается
 * кнопкой активации, а не копированием, и копирования он не делает.
 *
 * Заказ владельца 07.11: программа сама считает, какая это по счёту активация в
 * неделе аккаунта (неделя своя — 7 дней от первого использования), и по этому
 * номеру подставляет очки: 400, а в 4-й и 7-й — 1000. Если программа не смогла
 * определить номер (пропущенный день сбивает счётчик), владелец уточняет его
 * руками — и дальше программа продолжает считать от его номера.
 *
 * Отмена в диалоге ничего не активирует.
 *
 * Состояние живёт ВНУТРИ содержимого диалога: то содержимое размонтируется при
 * закрытии, поэтому каждое открытие начинается с чистых полей (без сброса
 * состояния в эффекте — так линтер и требует).
 */
export function MinimaxActivateDialog({
  open,
  onOpenChange,
  account,
  projects,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: AccountListItem | null;
  projects: ProjectListItem[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && account ? (
        <DialogContent>
          <ActivateForm
            account={account}
            projects={projects}
            onOpenChange={onOpenChange}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function ActivateForm({
  account,
  projects,
  onOpenChange,
}: {
  account: AccountListItem;
  projects: ProjectListItem[];
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [project, setProject] = useState<string>(
    account.projectId === null ? NONE : String(account.projectId),
  );

  // Чек-ин за сегодня уже был? Тогда номер активации дня уже записан, и
  // трогать его нельзя — иначе «не меняю» превратилось бы в затирку. Очки дня
  // показываем записанные (их можно поправить руками).
  const checkedInToday = account.weekCheckedInToday;
  const defaultIndex = checkedInToday
    ? (account.weekTodayIndex ?? account.week.nextIndex ?? WEEKLY_ACTIVATION_LIMIT)
    : (account.week.nextIndex ?? WEEKLY_ACTIVATION_LIMIT);
  const defaultTokens = checkedInToday ? account.lastTokens : pointsForIndex(defaultIndex);

  const [index, setIndex] = useState(String(defaultIndex));
  const [tokens, setTokens] = useState(String(defaultTokens));
  const [busy, setBusy] = useState(false);

  /** Смена номера активации пересчитывает очки: 400, а в 4-й и 7-й — 1000. */
  function onIndexChange(value: string) {
    setIndex(value);
    setTokens(String(pointsForIndex(Number(value))));
  }

  async function onSubmit() {
    setBusy(true);
    try {
      const raw = tokens.trim();
      const projectId = project === NONE ? null : Number(project);
      const tokensValue = raw === '' ? undefined : Number(raw);
      // Номер отправляем, только когда его можно менять: если чек-ин за
      // сегодня уже записан, номер дня не трогаем (сервер оставит прежний).
      const activationIndex = checkedInToday ? undefined : Number(index);

      const outcome = await activateAccountOnly(account.id, projectId, tokensValue, activationIndex);
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }

      toast.success('Аккаунт активирован — погаснет на 6 часов');
      // Другие вкладки раздела должны увидеть новое состояние (тот же канал,
      // что и у плавающего окна).
      publishMinimaxActivated(account.id);
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
          «{account.title || account.email}» — на какой проект зачесть активацию? Аккаунт
          погаснет на 6 часов с момента активации. Копирование почты или пароля аккаунт
          не гасит.
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
          <Label htmlFor="activate-index">Какая это по счёту активация в неделе</Label>
          <Select value={index} onValueChange={onIndexChange} disabled={checkedInToday}>
            <SelectTrigger id="activate-index">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEEKLY_ACTIVATION_POINTS.map((points, i) => (
                <SelectItem key={i + 1} value={String(i + 1)}>
                  {i + 1}-я активация — {points} очков
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {checkedInToday
              ? 'Сегодня чек-ин уже был — номер и очки дня записаны, их можно поправить только в поле очков.'
              : `Неделя аккаунта своя: 7 дней от первой активации. Сделано ${account.week.used} из ${WEEKLY_ACTIVATION_LIMIT}, осталось ${account.week.remaining}.`}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="activate-tokens">
            Очки за активацию (по умолчанию {defaultTokens})
          </Label>
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
          {busy ? 'Активирую…' : 'Активировать'}
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
