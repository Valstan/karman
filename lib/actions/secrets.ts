'use server';

import {
  secretProjectCreateSchema,
  secretProjectUpdateSchema,
  secretItemUpsertSchema,
  secretTokenCreateSchema,
} from '@/lib/validation/secret';
import {
  createProject,
  updateProject,
  deleteProject,
  upsertItem,
  deleteItem,
  revealItem,
  createToken,
  revokeToken,
} from '@/lib/services/secrets';
import { currentUserOrNull, revalidateAll, type ActionResult } from './_internal';

/** Уникальное нарушение Postgres (слаг занят). */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

export async function createProjectAction(values: unknown): Promise<ActionResult<{ id: number }>> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = secretProjectCreateSchema.safeParse(values);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  try {
    const id = await createProject(user, parsed.data);
    revalidateAll();
    return { ok: true, data: { id } };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'Слаг уже занят' };
    throw e;
  }
}

export async function updateProjectAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = secretProjectUpdateSchema.safeParse(values);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  try {
    const ok = await updateProject(user, parsed.data);
    if (!ok) return { ok: false, error: 'Проект не найден' };
    revalidateAll();
    return { ok: true };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'Слаг уже занят' };
    throw e;
  }
}

export async function deleteProjectAction(id: number): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const ok = await deleteProject(user, id);
  if (!ok) return { ok: false, error: 'Проект не найден' };
  revalidateAll();
  return { ok: true };
}

export async function upsertItemAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = secretItemUpsertSchema.safeParse(values);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  const ok = await upsertItem(user, parsed.data);
  if (!ok) return { ok: false, error: 'Проект не найден' };
  revalidateAll();
  return { ok: true };
}

export async function deleteItemAction(id: number): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const ok = await deleteItem(user, id);
  if (!ok) return { ok: false, error: 'Секрет не найден' };
  revalidateAll();
  return { ok: true };
}

/** Расшифровывает одно значение для показа владельцу. */
export async function revealItemAction(id: number): Promise<ActionResult<{ value: string }>> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  try {
    const value = await revealItem(user, id);
    if (value === null) return { ok: false, error: 'Секрет не найден' };
    return { ok: true, data: { value } };
  } catch {
    return { ok: false, error: 'Сервис секретов недоступен (мастер-ключ?)' };
  }
}

/** Создаёт токен; возвращает сам токен ОДИН раз (потом — только хэш в БД). */
export async function createTokenAction(values: unknown): Promise<ActionResult<{ token: string }>> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = secretTokenCreateSchema.safeParse(values);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  const token = await createToken(user, parsed.data);
  if (token === null) return { ok: false, error: 'Проект не найден' };
  revalidateAll();
  return { ok: true, data: { token } };
}

export async function revokeTokenAction(id: number): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const ok = await revokeToken(user, id);
  if (!ok) return { ok: false, error: 'Токен не найден' };
  revalidateAll();
  return { ok: true };
}
