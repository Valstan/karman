'use server';

import {
  familyPersonCreateSchema,
  familyPersonUpdateSchema,
  familyRelationSchema,
  idSchema,
} from '@/lib/validation/family';
import {
  addFamilyRelation,
  createFamilyPerson,
  deleteFamilyPerson,
  deleteFamilyRelation,
  reorderFamilyPeople,
  updateFamilyPerson,
} from '@/lib/services/family';
import { currentUserOrNull, revalidateAll, type ActionResult } from './_internal';

const AUTH = 'Требуется авторизация';
const BAD = 'Некорректные данные';

export async function createFamilyPersonAction(values: unknown): Promise<ActionResult<{ id: number }>> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: AUTH };
  const parsed = familyPersonCreateSchema.safeParse(values);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? BAD };
  const id = await createFamilyPerson(user, parsed.data);
  if (id === null) return { ok: false, error: 'Человек, к которому привязываете, не найден' };
  revalidateAll();
  return { ok: true, data: { id } };
}

export async function updateFamilyPersonAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: AUTH };
  const parsed = familyPersonUpdateSchema.safeParse(values);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? BAD };
  const ok = await updateFamilyPerson(user, parsed.data.id, parsed.data.person);
  if (!ok) return { ok: false, error: 'Человек не найден' };
  revalidateAll();
  return { ok: true };
}

export async function deleteFamilyPersonAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: AUTH };
  const parsed = idSchema.safeParse(values);
  if (!parsed.success) return { ok: false, error: BAD };
  const ok = await deleteFamilyPerson(user, parsed.data.id);
  if (!ok) return { ok: false, error: 'Человек не найден' };
  revalidateAll();
  return { ok: true };
}

export async function reorderFamilyPeopleAction(ids: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: AUTH };
  if (!Array.isArray(ids) || !ids.every((i) => Number.isInteger(i) && i > 0) || ids.length > 1000) {
    return { ok: false, error: BAD };
  }
  const ok = await reorderFamilyPeople(user, ids as number[]);
  if (!ok) return { ok: false, error: 'Список содержит чужие или несуществующие записи' };
  revalidateAll();
  return { ok: true };
}

export async function addFamilyRelationAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: AUTH };
  const parsed = familyRelationSchema.safeParse(values);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? BAD };
  const result = await addFamilyRelation(user, parsed.data);
  if (result === 'self') return { ok: false, error: 'Человек не может быть связан сам с собой' };
  if (result === 'not-found') return { ok: false, error: 'Один из людей не найден' };
  if (result === 'exists') return { ok: false, error: 'Такая связь уже есть' };
  revalidateAll();
  return { ok: true };
}

export async function deleteFamilyRelationAction(values: unknown): Promise<ActionResult> {
  const user = await currentUserOrNull();
  if (!user) return { ok: false, error: AUTH };
  const parsed = idSchema.safeParse(values);
  if (!parsed.success) return { ok: false, error: BAD };
  const ok = await deleteFamilyRelation(user, parsed.data.id);
  if (!ok) return { ok: false, error: 'Связь не найдена' };
  revalidateAll();
  return { ok: true };
}
