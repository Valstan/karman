import 'server-only';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { secretsAudit, secretsItem, secretsProject } from '@/lib/db/schema';
import { decryptSecret, encryptSecret, secretAad } from '@/lib/secrets/crypto';
import { actorRoom } from '@/lib/secrets/actor';
import { isoNow, logAudit } from './internal';
import { activeGrantsFor, resolveApiToken } from './token';
import type { SecretDeriveInput, SecretDeriveRestoreInput } from '@/lib/validation/secret';

/**
 * Производные секреты и их родословная (D-191, мандат brain 08.11, ADR-0015).
 *
 * ## Что это
 *
 * Производная — копия чужого секрета в своей комнате: «возьми значение X из комнаты
 * источника и положи его ко мне под именем Y». Пока копия не помнила источника, смерть
 * источника проходила для неё молча, и «кого предупредить перед ротацией» собрать было
 * нечем. Теперь у копии есть родословная: комната-источник, ключ оригинала, кто вывел,
 * когда — и отметка «источник умер».
 *
 * ## Правила (ответы brain 08.11 и 12.11)
 *
 * - **Вывод разрешён только по действующей выдаче.** Копия не выдаёт права на источник
 *   (ADR-0015 п.5): получив копию, комната не читает ею источник. Поэтому источник
 *   ищется не по имени, а по действующей выдаче получателя.
 * - **Производную создаёт только пишущий токен.** RO-токен не может: это расширение
 *   права записи (прямая граница D-185). Если канал проекта только RO, нужен отдельный
 *   rw-токен по правилам выдачи.
 * - **Смерть источника** (запись удалили / комнату-источник удалили / ключ переименовали)
 *   → копии помечаются `orphaned` **и в аудите поднимается список домов** (в каких
 *   комнатах живут копии). Помечает код удаления, в той же операции и в том же аудите,
 *   что и сама смерть: триггер БД правит строки молча, а след там и нужен (G600).
 * - **Отзыв токена комнаты-источника — НЕ смерть источника**: комнату можно
 *   перевыпустить, поэтому копии помечаются флагом «источник недоступен» и поднимаются
 *   в аудите, но `orphaned` не ставится. Флаг снимается, когда у комнаты-источника
 *   снова есть живой токен.
 * - **Смерть источника — это не отзыв токена** (см. выше) и не перезапись значения:
 *   значение копии остаётся, каскад только помечает.
 *
 * ## Реестр домов (#226)
 *
 * При рождении копии в аудит комнаты-источника пишется строка «дом: комната X, ключ Y,
 * создано Z», при смерти источника — список домов в аудит каждой копии. Без этого
 * «список читателей перед ротацией» собрать нечем.
 */
export type DerivedSecret = {
  /** Имя копии в комнате-получателя. */
  key: string;
  /** Комната-источник оригинала. */
  origin_project_slug: string;
  /** Ключ оригинала в комнате-источнике. */
  origin_key: string;
  /** Когда вывели. */
  derived_at: string;
  /** Источник умер — копия осиротела. */
  orphaned: boolean;
  /** Источник жив, но недоступен (у комнаты-источника нет живых токенов). */
  source_unavailable: boolean;
};

/** Дом производной: где живёт копия (для реестра домов источника). */
export type DerivationHome = {
  /** Комната, в которой живёт копия. */
  room: string;
  /** Имя копии в этой комнате. */
  key: string;
  /** Когда вывели. */
  derived_at: string;
  orphaned: boolean;
  source_unavailable: boolean;
};

export type DeriveResult =
  | { ok: true; derived: DerivedSecret }
  | { ok: false; status: 400 | 401 | 403 | 404 | 409; error: string };

/**
 * Транзакция — тот же клиент, что и `db`, только внутри транзакции (drizzle отдаёт
 * объект того же класса). Тип берём по образцу `lib/services/family.ts`: там он тоже
 * касткуется на месте вызова.
 */
export type DerivationTx = typeof db;

/**
 * Вывести производную: значение источника — копией в комнате вызывающего.
 *
 * Источник берётся ровно так, как его видит вызывающий: под алиасом действующей
 * выдачи. Истинный источник (комната и ключ оригинала) дочитывается по выдаче — в
 * родословной лежит оригинал, а не то имя, под которым источник увидел потребитель.
 */
export async function deriveSecretByToken(
  rawToken: string,
  ip: string | null,
  input: SecretDeriveInput,
): Promise<DeriveResult> {
  const resolved = await resolveApiToken(rawToken);
  if (!resolved.ok) {
    await logAudit(resolved.projectId, resolved.tokenId, 'derive_denied', resolved.reason, ip);
    return { ok: false, status: 401, error: 'Недействительный токен' };
  }
  const tok = resolved.token;
  if (!tok.canWrite) {
    await logAudit(
      tok.projectId,
      tok.id,
      'derive_denied',
      'производную создаёт только токен с правом записи',
      ip,
    );
    return {
      ok: false,
      status: 403,
      error: 'Производную создаёт только токен с правом записи',
    };
  }

  // Принципал аудита — комната (D-061): выводит комната, а не «кто-то с токеном».
  const [myRoom] = await db
    .select({ id: secretsProject.id, slug: secretsProject.slug })
    .from(secretsProject)
    .where(eq(secretsProject.id, tok.projectId))
    .limit(1);
  if (!myRoom) {
    await logAudit(tok.projectId, tok.id, 'derive_denied', 'комната не найдена', ip);
    return { ok: false, status: 401, error: 'Недействительный токен' };
  }
  const actor = actorRoom(myRoom.slug);

  // Действующая выдача — единственный путь к чужому источнику (ADR-0015 п.5).
  // Алиас у получателя уникален (частичный уникальный индекс), так что выдача
  // находится однозначно.
  const grants = await activeGrantsFor(tok.projectId);
  const granted = grants.find((g) => g.aliasKey === input.source_key);
  if (!granted) {
    await logAudit(
      tok.projectId,
      tok.id,
      'derive_denied',
      `нет действующей выдачи под именем ${input.source_key}`,
      ip,
    );
    return {
      ok: false,
      status: 403,
      error: 'Нет действующей выдачи на этот источник: производную нельзя вывести',
    };
  }

  const originProjectId = granted.sourceProjectId;
  const originKey = granted.sourceKey;

  const [sourceRoom] = await db
    .select({ id: secretsProject.id, slug: secretsProject.slug })
    .from(secretsProject)
    .where(eq(secretsProject.id, originProjectId))
    .limit(1);
  if (!sourceRoom) {
    await logAudit(tok.projectId, tok.id, 'derive_denied', 'комната-источник не найдена', ip);
    return { ok: false, status: 404, error: 'Комната-источник не найдена' };
  }
  if (input.source_slug && input.source_slug !== sourceRoom.slug) {
    await logAudit(
      tok.projectId,
      tok.id,
      'derive_denied',
      `комната-источник «${input.source_slug}» не совпадает с выдачей из «${sourceRoom.slug}»`,
      ip,
    );
    return {
      ok: false,
      status: 404,
      error: 'Такой комнаты-источника нет среди ваших действующих выдач',
    };
  }

  const [sourceItem] = await db
    .select({ ciphertext: secretsItem.ciphertext, iv: secretsItem.iv, authTag: secretsItem.authTag })
    .from(secretsItem)
    .where(and(eq(secretsItem.projectId, originProjectId), eq(secretsItem.key, originKey)))
    .limit(1);
  if (!sourceItem) {
    await logAudit(
      tok.projectId,
      tok.id,
      'derive_denied',
      `источник «${sourceRoom.slug}/${originKey}» не найден`,
      ip,
    );
    return { ok: false, status: 404, error: 'Источник не найден' };
  }
  const value = decryptSecret(sourceItem, secretAad(originProjectId, originKey));

  // Своё имя поверх выдачи не занимаем — тот же гейт, что и на записи (push).
  if (grants.some((g) => g.aliasKey === input.target_key)) {
    await logAudit(
      tok.projectId,
      tok.id,
      'derive_denied',
      `имя ${input.target_key} занято выданной выдачей`,
      ip,
    );
    return {
      ok: false,
      status: 409,
      error: 'Это имя занято выданной выдачей — выберите другое',
    };
  }

  // Свой ключ комнаты производная не затирает: молча сменить значение секрета
  // нельзя — это расширение права записи по чужому ключу.
  const [existing] = await db
    .select({ id: secretsItem.id })
    .from(secretsItem)
    .where(and(eq(secretsItem.projectId, tok.projectId), eq(secretsItem.key, input.target_key)))
    .limit(1);
  if (existing) {
    await logAudit(
      tok.projectId,
      tok.id,
      'derive_denied',
      `имя ${input.target_key} уже занято своим секретом`,
      ip,
    );
    return {
      ok: false,
      status: 409,
      error: 'В комнате уже есть секрет под таким именем',
    };
  }

  const enc = encryptSecret(value, secretAad(tok.projectId, input.target_key));
  const now = isoNow();
  await db
    .insert(secretsItem)
    .values({
      projectId: tok.projectId,
      key: input.target_key,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      originProjectId,
      originKey,
      derivedBy: tok.projectId,
      derivedAt: now,
    });

  // Аудит получателя: что выведено и откуда.
  await logAudit(
    tok.projectId,
    tok.id,
    'secret_derived',
    `выведена производная ${input.target_key} из «${sourceRoom.slug}/${originKey}»${
      input.note ? `; ${input.note}` : ''
    }`,
    ip,
    actor,
  );
  // Реестр домов: у источника появляется строка «дом: комната X, ключ Y, создано Z».
  await logAudit(
    originProjectId,
    null,
    'derivation_created',
    `дом: комната ${myRoom.slug}, ключ ${input.target_key}, создано ${now}${
      input.note ? `; ${input.note}` : ''
    }`,
    ip,
    actor,
  );

  return {
    ok: true,
    derived: {
      key: input.target_key,
      origin_project_slug: sourceRoom.slug,
      origin_key: originKey,
      derived_at: now,
      orphaned: false,
      source_unavailable: false,
    },
  };
}

/** Производные комнаты — с родословной и отметками «источник умер»/«недоступен». */
export async function listDerivationsByToken(
  rawToken: string,
  ip: string | null,
): Promise<
  | { ok: true; slug: string; derivations: DerivedSecret[] }
  | { ok: false; status: 401; error: string }
> {
  const resolved = await resolveApiToken(rawToken);
  if (!resolved.ok) {
    await logAudit(resolved.projectId, resolved.tokenId, 'derivations_denied', resolved.reason, ip);
    return { ok: false, status: 401, error: 'Недействительный токен' };
  }
  const tok = resolved.token;

  const [room] = await db
    .select({ slug: secretsProject.slug })
    .from(secretsProject)
    .where(eq(secretsProject.id, tok.projectId))
    .limit(1);

  const rows = await db
    .select({
      key: secretsItem.key,
      originKey: secretsItem.originKey,
      originProjectId: secretsItem.originProjectId,
      derivedAt: secretsItem.derivedAt,
      orphanedAt: secretsItem.orphanedAt,
      sourceUnavailableAt: secretsItem.sourceUnavailableAt,
    })
    .from(secretsItem)
    .where(and(eq(secretsItem.projectId, tok.projectId), isNotNull(secretsItem.originKey)));

  const originIds = [
    ...new Set(rows.map((r) => r.originProjectId).filter((v): v is number => v !== null)),
  ];
  const origins = originIds.length
    ? await db
        .select({ id: secretsProject.id, slug: secretsProject.slug })
        .from(secretsProject)
        .where(inArray(secretsProject.id, originIds))
    : [];
  const originSlug = new Map(origins.map((o) => [o.id, o.slug]));

  const derivations = rows.map((r) => ({
    key: r.key,
    // null — комната-источник удалена (ссылка обнулилась каскадом).
    origin_project_slug:
      r.originProjectId === null
        ? '(комната-источник удалена)'
        : (originSlug.get(r.originProjectId) ?? '(комната-источник удалена)'),
    origin_key: r.originKey ?? '',
    derived_at: r.derivedAt ?? '',
    orphaned: r.orphanedAt !== null,
    source_unavailable: r.sourceUnavailableAt !== null,
  }));

  return { ok: true, slug: room?.slug ?? '', derivations };
}

/**
 * Дома моего ключа: кто и когда завёл его копии (реестр домов, #226).
 *
 * Отчёт владельца данных источника: «кто, когда, в какую комнату». Ключ обязан
 * лежать в моей комнате — иначе это не мой источник и отвечать не на что.
 */
export async function listHomesByToken(
  rawToken: string,
  ip: string | null,
  sourceKey: string,
): Promise<
  | { ok: true; slug: string; source_key: string; homes: DerivationHome[] }
  | { ok: false; status: 401 | 404; error: string }
> {
  const resolved = await resolveApiToken(rawToken);
  if (!resolved.ok) {
    await logAudit(resolved.projectId, resolved.tokenId, 'homes_denied', resolved.reason, ip);
    return { ok: false, status: 401, error: 'Недействительный токен' };
  }
  const tok = resolved.token;

  const [mine] = await db
    .select({ id: secretsItem.id })
    .from(secretsItem)
    .where(and(eq(secretsItem.projectId, tok.projectId), eq(secretsItem.key, sourceKey)))
    .limit(1);
  if (!mine) {
    await logAudit(tok.projectId, tok.id, 'homes_denied', `ключ ${sourceKey} не найден`, ip);
    return { ok: false, status: 404, error: 'Ключ не найден в вашей комнате' };
  }

  const [room] = await db
    .select({ slug: secretsProject.slug })
    .from(secretsProject)
    .where(eq(secretsProject.id, tok.projectId))
    .limit(1);

  const copies = await db
    .select({
      projectId: secretsItem.projectId,
      key: secretsItem.key,
      derivedAt: secretsItem.derivedAt,
      orphanedAt: secretsItem.orphanedAt,
      sourceUnavailableAt: secretsItem.sourceUnavailableAt,
    })
    .from(secretsItem)
    .where(
      and(
        eq(secretsItem.originProjectId, tok.projectId),
        eq(secretsItem.originKey, sourceKey),
        isNotNull(secretsItem.originKey),
      ),
    );

  const roomIds = [...new Set(copies.map((c) => c.projectId))];
  const rooms = roomIds.length
    ? await db
        .select({ id: secretsProject.id, slug: secretsProject.slug })
        .from(secretsProject)
        .where(inArray(secretsProject.id, roomIds))
    : [];
  const slugById = new Map(rooms.map((r) => [r.id, r.slug]));

  const homes: DerivationHome[] = copies.map((c) => ({
    room: slugById.get(c.projectId) ?? String(c.projectId),
    key: c.key,
    derived_at: c.derivedAt ?? '',
    orphaned: c.orphanedAt !== null,
    source_unavailable: c.sourceUnavailableAt !== null,
  }));

  return { ok: true, slug: room?.slug ?? '', source_key: sourceKey, homes };
}

/**
 * Снять пометку «источник умер» с производной (мандат brain 08.11: «Отмена: снять
 * пометку, если копия ещё жива и нужна»).
 *
 * Право — у комнаты копии и только с пишущим токеном: это операция записи. Пометку
 * снимает тот, кому копия принадлежит; в ответе — жив ли источник сейчас (он мог
 * появиться снова: ключ переименовали и вернули).
 */
export async function restoreDerivationByToken(
  rawToken: string,
  ip: string | null,
  input: SecretDeriveRestoreInput,
): Promise<
  | { ok: true; key: string; source_alive: boolean }
  | { ok: false; status: 401 | 403 | 404 | 409; error: string }
> {
  const resolved = await resolveApiToken(rawToken);
  if (!resolved.ok) {
    await logAudit(resolved.projectId, resolved.tokenId, 'restore_denied', resolved.reason, ip);
    return { ok: false, status: 401, error: 'Недействительный токен' };
  }
  const tok = resolved.token;
  if (!tok.canWrite) {
    await logAudit(
      tok.projectId,
      tok.id,
      'restore_denied',
      'пометку снимает только токен с правом записи',
      ip,
    );
    return {
      ok: false,
      status: 403,
      error: 'Пометку снимает только токен с правом записи',
    };
  }

  const [room] = await db
    .select({ slug: secretsProject.slug })
    .from(secretsProject)
    .where(eq(secretsProject.id, tok.projectId))
    .limit(1);
  const actor = actorRoom(room?.slug ?? String(tok.projectId));

  const [copy] = await db
    .select({
      id: secretsItem.id,
      originKey: secretsItem.originKey,
      originProjectId: secretsItem.originProjectId,
      orphanedAt: secretsItem.orphanedAt,
    })
    .from(secretsItem)
    .where(and(eq(secretsItem.projectId, tok.projectId), eq(secretsItem.key, input.key)))
    .limit(1);
  if (!copy || copy.originKey === null) {
    await logAudit(tok.projectId, tok.id, 'restore_denied', `производная ${input.key} не найдена`, ip);
    return { ok: false, status: 404, error: 'Производная не найдена' };
  }
  if (copy.orphanedAt === null) {
    await logAudit(
      tok.projectId,
      tok.id,
      'restore_denied',
      `у производной ${input.key} нет пометки «источник умер»`,
      ip,
    );
    return {
      ok: false,
      status: 409,
      error: 'У этой производной нет пометки «источник умер» — снимать нечего',
    };
  }

  await db
    .update(secretsItem)
    .set({ orphanedAt: null })
    .where(and(eq(secretsItem.id, copy.id)));

  // Источник жив ли сейчас — вернём это вызывающему: снимать пометку имеет смысл,
  // когда источник снова есть (ключ переименовали и вернули).
  let sourceAlive = false;
  if (copy.originProjectId !== null) {
    const [origin] = await db
      .select({ id: secretsItem.id })
      .from(secretsItem)
      .where(
        and(
          eq(secretsItem.projectId, copy.originProjectId),
          eq(secretsItem.key, copy.originKey),
        ),
      )
      .limit(1);
    sourceAlive = Boolean(origin);
  }

  await logAudit(
    tok.projectId,
    tok.id,
    'derivation_restored',
    `пометка «источник умер» снята с производной ${input.key}${
      sourceAlive ? '; источник снова есть' : '; источник по-прежнему мёртв'
    }`,
    ip,
    actor,
  );

  return { ok: true, key: input.key, source_alive: sourceAlive };
}

/**
 * Пометить производные осиротевшими — источник умер.
 *
 * Вызывается из путей удаления (запись удалили / комнату-источник удалили) В ТОЙ ЖЕ
 * операции и в том же аудите, что и сама смерть (G600: след должен быть рядом с
 * событием, а не «где-то потом»).
 *
 * В аудите копии поднимается **список домов** — в каких комнатах живут копии: без него
 * «кого предупредить перед ротацией» не собрать (#226).
 */
export async function markDerivationsOrphaned(
  tx: DerivationTx,
  originProjectId: number,
  originKey: string,
  actor: string,
): Promise<number> {
  const copies = await tx
    .select({
      id: secretsItem.id,
      projectId: secretsItem.projectId,
      key: secretsItem.key,
    })
    .from(secretsItem)
    .where(
      and(
        eq(secretsItem.originProjectId, originProjectId),
        eq(secretsItem.originKey, originKey),
        isNull(secretsItem.orphanedAt),
      ),
    );
  if (copies.length === 0) return 0;

  // Дома: комната и имя, где живёт каждая копия.
  const projectIds = [...new Set(copies.map((c) => c.projectId))];
  const rooms = await tx
    .select({ id: secretsProject.id, slug: secretsProject.slug })
    .from(secretsProject)
    .where(inArray(secretsProject.id, projectIds));
  const slugById = new Map(rooms.map((r) => [r.id, r.slug]));
  const homeList = copies
    .map((c) => `${slugById.get(c.projectId) ?? c.projectId}/${c.key}`)
    .sort()
    .join(', ');

  await tx
    .update(secretsItem)
    .set({ orphanedAt: isoNow() })
    .where(
      and(
        eq(secretsItem.originProjectId, originProjectId),
        eq(secretsItem.originKey, originKey),
        isNull(secretsItem.orphanedAt),
      ),
    );

  // Аудит — в комнату каждой копии: именно ей надо знать, что источник умер.
  for (const copy of copies) {
    await tx.insert(secretsAudit).values({
      projectId: copy.projectId,
      tokenId: null,
      action: 'secret_orphaned',
      detail: `источник ${originProjectId}/${originKey} мёртв; копии: ${homeList}`,
      ip: null,
      actor,
    });
  }
  return copies.length;
}

/**
 * Пометить копии «источник недоступен» — у комнаты-источника отозвали последний живой
 * токен. Это НЕ смерть источника (комнату можно перевыпустить): `orphaned` не
 * ставится, копии продолжают работать, но получатель должен знать, что источник
 * больше недоступен.
 */
export async function markDerivationsSourceUnavailable(
  tx: DerivationTx,
  originProjectId: number,
  actor: string,
): Promise<number> {
  const copies = await tx
    .select({ id: secretsItem.id, projectId: secretsItem.projectId, key: secretsItem.key })
    .from(secretsItem)
    .where(
      and(
        eq(secretsItem.originProjectId, originProjectId),
        isNull(secretsItem.sourceUnavailableAt),
      ),
    );
  if (copies.length === 0) return 0;

  const projectIds = [...new Set(copies.map((c) => c.projectId))];
  const rooms = await tx
    .select({ id: secretsProject.id, slug: secretsProject.slug })
    .from(secretsProject)
    .where(inArray(secretsProject.id, projectIds));
  const slugById = new Map(rooms.map((r) => [r.id, r.slug]));
  const homeList = copies
    .map((c) => `${slugById.get(c.projectId) ?? c.projectId}/${c.key}`)
    .sort()
    .join(', ');

  await tx
    .update(secretsItem)
    .set({ sourceUnavailableAt: isoNow() })
    .where(
      and(
        eq(secretsItem.originProjectId, originProjectId),
        isNull(secretsItem.sourceUnavailableAt),
      ),
    );

  for (const copy of copies) {
    await tx.insert(secretsAudit).values({
      projectId: copy.projectId,
      tokenId: null,
      action: 'source_unavailable',
      detail: `источник ${originProjectId} недоступен (у комнаты не осталось живых токенов); копии: ${homeList}`,
      ip: null,
      actor,
    });
  }
  return copies.length;
}

/**
 * Снять пометку «источник недоступен» — у комнаты-источника снова появился живой токен.
 * Смертью источника это не является: `orphaned` не трогаем.
 */
export async function clearDerivationsSourceUnavailable(
  tx: DerivationTx,
  originProjectId: number,
  actor: string,
): Promise<number> {
  const copies = await tx
    .select({ id: secretsItem.id, projectId: secretsItem.projectId })
    .from(secretsItem)
    .where(
      and(
        eq(secretsItem.originProjectId, originProjectId),
        isNotNull(secretsItem.sourceUnavailableAt),
      ),
    );
  if (copies.length === 0) return 0;

  await tx
    .update(secretsItem)
    .set({ sourceUnavailableAt: null })
    .where(
      and(
        eq(secretsItem.originProjectId, originProjectId),
        isNotNull(secretsItem.sourceUnavailableAt),
      ),
    );

  for (const copy of copies) {
    await tx.insert(secretsAudit).values({
      projectId: copy.projectId,
      tokenId: null,
      action: 'source_available',
      detail: `источник ${originProjectId} снова доступен`,
      ip: null,
      actor,
    });
  }
  return copies.length;
}
