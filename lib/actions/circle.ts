'use server';

import {
  circleIdSchema,
  circleInviteSchema,
  circleMemberSchema,
  circleNameSchema,
  circleRenameSchema,
  circleRespondSchema,
} from '@/lib/validation/circle';
import {
  createCircle,
  deleteCircle,
  inviteToCircle,
  leaveCircle,
  removeFromCircle,
  renameCircle,
  respondToInvite,
} from '@/lib/services/circle';
import { currentUserOrNull, revalidateAll, type ActionResult } from './_internal';

/**
 * Действия круга. Все они меняют ВИДИМОСТЬ персональных данных, поэтому каждое
 * проверяет права внутри сервиса, а не здесь: экшен — это транспорт, и проверка
 * в нём означала бы, что вызов сервиса откуда-то ещё проходит без проверки.
 */

export async function createCircleAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = circleNameSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  const result = await createCircle(user, parsed.data.name);
  if (!result.ok) return { ok: false, error: result.error };
  revalidateAll();
  return { ok: true };
}

export async function renameCircleAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = circleRenameSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  const result = await renameCircle(user, parsed.data.circleId, parsed.data.name);
  if (!result.ok) return { ok: false, error: result.error };
  revalidateAll();
  return { ok: true };
}

export async function inviteToCircleAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = circleInviteSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  const result = await inviteToCircle(user, parsed.data.circleId, parsed.data.username);
  if (!result.ok) return { ok: false, error: result.error };
  revalidateAll();
  return { ok: true };
}

export async function respondToInviteAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = circleRespondSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  const result = await respondToInvite(user, parsed.data.circleId, parsed.data.accept);
  if (!result.ok) return { ok: false, error: result.error };
  revalidateAll();
  return { ok: true };
}

export async function leaveCircleAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = circleIdSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  const result = await leaveCircle(user, parsed.data.circleId);
  if (!result.ok) return { ok: false, error: result.error };
  revalidateAll();
  return { ok: true };
}

export async function removeFromCircleAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = circleMemberSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  const result = await removeFromCircle(user, parsed.data.circleId, parsed.data.userId);
  if (!result.ok) return { ok: false, error: result.error };
  revalidateAll();
  return { ok: true };
}

export async function deleteCircleAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: 'Требуется авторизация' };
  const parsed = circleIdSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' };
  }
  const result = await deleteCircle(user, parsed.data.circleId);
  if (!result.ok) return { ok: false, error: result.error };
  revalidateAll();
  return { ok: true };
}
