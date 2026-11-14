import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { accountToken, accountTokenFlow, accountsAccount } from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import { decryptSecret, encryptSecret } from '@/lib/secrets/crypto';
import {
  exchangeDeviceCode,
  pkcePair,
  startDeviceFlow,
  verificationLink,
  type DeviceFlowError,
} from '@/lib/minimax/oauth';

/**
 * Токены аккаунтов MiniMax: добыча через OAuth device-flow и выдача проекту.
 *
 * ЗАКАЗ ВЛАДЕЛЬЦА (14.11): «напишешь скрипт-программу с веб-интерфейсом на кармане,
 * чтобы я туда зашел и просто щелкал кнопку "Следующий" и ты давал ссылку для
 * авторизации, я проходил авторизацию и скрипт забирал токен и клал его в базу для
 * этого аккаунта и так по кругу пока все аккаунты не пройду и не получу токены, тоесть
 * скрипт должен видеть что если у акаунта уже есть токен, то его пропустить, и если
 * токены есть у всех аккаунтов то остановить процесс получение токенов и сообщить
 * оператору что все токены получены».
 *
 * ## Правило одноразового refresh
 *
 * Refresh-токен у MiniMax **одноразовый**: повторное использование вендер считает
 * злоупотреблением и отзывает цепочку (рецепт Сарафана, 14.11). Значит:
 *
 * - добытая пара хранится шифротекстом (ключ мастер-ключа vault, AAD — id аккаунта);
 * - проект получает пару **один раз** (отдача помечается `handed_over_at`), и после
 *   этого мы **не крутим** свой refresh никогда;
 * - если проект прислал обновлённую пару (он её обновил, а мы сохранили) — можно
 *   отдавать снова: приём пары обратно снимает отметку отдачи.
 */

/** AAD шифротекста пары токенов — привязывает блок к аккаунту. */
export function accountTokenAad(accountId: number): string {
  return `accounts:account:${accountId}:token`;
}

/** AAD шифротекста device-flow (device_code и code_verifier). */
export function accountTokenFlowAad(flowId: number): string {
  return `accounts:token-flow:${flowId}`;
}

/** Состояние аккаунта в процессе добычи токенов. */
export type AccountTokenState = 'none' | 'pending' | 'stored' | 'handed_over';

export type AccountTokenRow = {
  account_id: number;
  title: string;
  email: string;
  state: AccountTokenState;
  /** Срок жизни access-токена (ISO) — когда он истечёт. */
  expires_at: string | null;
  /** Когда пару отдали проекту (ISO) или null. */
  handed_over_at: string | null;
};

export type TokenProgress = {
  total: number;
  /** Аккаунтов с добытой парой (включая уже отданную). */
  withToken: number;
  /** Осталось добыть. */
  remaining: number;
  /** Аккаунтов в состоянии «ждём владельца». */
  pending: number;
  /** Всё добыто — процесс можно закрывать. */
  complete: boolean;
  rows: AccountTokenRow[];
};

/**
 * Состояние пула по токенам: что уже есть, что ждёт, что осталось.
 *
 * Аккаунты без токена идут в порядке id — «Следующий» идёт по кругу сверху, как
 * список владельца.
 */
export async function tokenProgress(user: SessionUser): Promise<TokenProgress> {
  const [accounts, flows, tokens] = await Promise.all([
    db
      .select({ id: accountsAccount.id, title: accountsAccount.title, email: accountsAccount.email })
      .from(accountsAccount)
      .where(ownership(user, accountsAccount.userId))
      .orderBy(asc(accountsAccount.id)),
    db
      .select({
        accountId: accountTokenFlow.accountId,
        state: accountTokenFlow.state,
        createdAt: accountTokenFlow.createdAt,
      })
      .from(accountTokenFlow)
      .where(
        and(
          ownership(user, accountTokenFlow.userId),
          eq(accountTokenFlow.state, 'pending'),
        ),
      ),
    db
      .select({
        accountId: accountToken.accountId,
        expiresAt: accountToken.expiresAt,
        handedOverAt: accountToken.handedOverAt,
      })
      .from(accountToken)
      .where(ownership(user, accountToken.userId)),
  ]);

  const pendingBy = new Map(flows.map((row) => [row.accountId, row]));
  const tokenBy = new Map(tokens.map((row) => [row.accountId, row]));

  const rows: AccountTokenRow[] = accounts.map((account) => {
    const token = tokenBy.get(account.id);
    const state: AccountTokenState = token
      ? token.handedOverAt
        ? 'handed_over'
        : 'stored'
      : pendingBy.has(account.id)
        ? 'pending'
        : 'none';
    return {
      account_id: account.id,
      title: account.title,
      email: account.email,
      state,
      expires_at: token ? token.expiresAt : null,
      handed_over_at: token?.handedOverAt ?? null,
    };
  });

  const withToken = rows.filter((row) => row.state === 'stored' || row.state === 'handed_over').length;
  const pending = rows.filter((row) => row.state === 'pending').length;

  return {
    total: rows.length,
    withToken,
    remaining: rows.length - withToken,
    pending,
    complete: rows.length > 0 && withToken === rows.length,
    rows,
  };
}

/** Результат «Следующий»: что владельцу показывать. */
export type NextTokenFlow = {
  /** id строки device-flow — по нему идёт обмен кода. */
  flow_id: number;
  account_id: number;
  title: string;
  email: string;
  /** Код, который владелец вводит на странице MiniMax. */
  user_code: string;
  /** Ссылка подтверждения (с кодом в query). */
  verification_link: string;
  /** Когда код перестанет работать (ISO). */
  expires_at: string;
  /** Как часто опрашивать обмен (секунды). */
  interval_seconds: number;
  /** Продолжаем ли уже начатый flow (код ещё жив). */
  resumed: boolean;
};

/**
 * «Следующий» — следующий аккаунт без токена.
 *
 * Если на аккаунте уже висит живой (не истёкший) device-flow — возвращаем его:
 * владелец мог просто не успеть подтвердить, и начинать заново с другим аккаунтом
 * означало бы оставлять висящие коды. Аккаунты с уже добытым токеном пропускаются
 * (заказ владельца: «если у аккаунта уже есть токен, то его пропустить»).
 */
export async function startNextTokenFlow(
  user: SessionUser,
  now: Date = new Date(),
): Promise<
  | { ok: true; flow: NextTokenFlow }
  | { ok: false; error: 'complete' | 'oauth_failed'; message?: string }
> {
  const progress = await tokenProgress(user);

  // Живой открытый flow — продолжаем его.
  const open = await db
    .select({
      id: accountTokenFlow.id,
      accountId: accountTokenFlow.accountId,
      userCode: accountTokenFlow.userCode,
      verificationUri: accountTokenFlow.verificationUri,
      verificationUriComplete: accountTokenFlow.verificationUriComplete,
      expiresAt: accountTokenFlow.expiresAt,
    })
    .from(accountTokenFlow)
    .where(
      and(
        ownership(user, accountTokenFlow.userId),
        eq(accountTokenFlow.state, 'pending'),
      ),
    )
    .orderBy(asc(accountTokenFlow.id))
    .limit(1);
  const pendingFlow = open[0];

  if (pendingFlow) {
    const expiresAt = new Date(pendingFlow.expiresAt);
    if (expiresAt.getTime() > now.getTime()) {
      const account = progress.rows.find((row) => row.account_id === pendingFlow.accountId);
      return {
        ok: true,
        flow: {
          flow_id: pendingFlow.id,
          account_id: pendingFlow.accountId,
          title: account?.title ?? '',
          email: account?.email ?? '',
          user_code: pendingFlow.userCode,
          verification_link: pendingFlow.verificationUriComplete
            ? pendingFlow.verificationUriComplete
            : verificationLink(pendingFlow.verificationUri, pendingFlow.userCode),
          expires_at: expiresAt.toISOString(),
          interval_seconds: 5,
          resumed: true,
        },
      };
    }
    // Код выдохся — помечаем и идём к следующему аккаунту.
    await db
      .update(accountTokenFlow)
      .set({ state: 'expired', updatedAt: now.toISOString() })
      .where(eq(accountTokenFlow.id, pendingFlow.id));
  }

  const next = progress.rows.find((row) => row.state === 'none');
  if (!next) {
    return { ok: false, error: 'complete' };
  }

  const { verifier, challenge } = pkcePair();
  const started = await startDeviceFlow(challenge);
  if (!started.ok) {
    return { ok: false, error: 'oauth_failed', message: started.message ?? started.error };
  }

  const expiresAt = new Date(now.getTime() + started.data.expiresInSeconds * 1000);
  const [created] = await db
    .insert(accountTokenFlow)
    .values({
      userId: user.id,
      accountId: next.account_id,
      deviceCode: '',
      deviceCodeIv: '',
      deviceCodeTag: '',
      codeVerifier: '',
      codeVerifierIv: '',
      codeVerifierTag: '',
      userCode: started.data.userCode,
      verificationUri: started.data.verificationUri,
      verificationUriComplete: started.data.verificationUriComplete,
      expiresAt: expiresAt.toISOString(),
      state: 'pending',
      createdAt: now.toISOString(),
    })
    .returning({ id: accountTokenFlow.id });

  // Секреты пишем шифротекстом: AAD привязывает блок к id потока.
  const flowId = created!.id;
  const deviceEnc = encryptSecret(started.data.deviceCode, accountTokenFlowAad(flowId));
  const verifierEnc = encryptSecret(verifier, accountTokenFlowAad(flowId));
  await db
    .update(accountTokenFlow)
    .set({
      deviceCode: deviceEnc.ciphertext,
      deviceCodeIv: deviceEnc.iv,
      deviceCodeTag: deviceEnc.authTag,
      codeVerifier: verifierEnc.ciphertext,
      codeVerifierIv: verifierEnc.iv,
      codeVerifierTag: verifierEnc.authTag,
      updatedAt: now.toISOString(),
    })
    .where(eq(accountTokenFlow.id, flowId));

  return {
    ok: true,
    flow: {
      flow_id: flowId,
      account_id: next.account_id,
      title: next.title,
      email: next.email,
      user_code: started.data.userCode,
      verification_link: started.data.verificationUriComplete
        ? started.data.verificationUriComplete
        : verificationLink(started.data.verificationUri, started.data.userCode),
      expires_at: expiresAt.toISOString(),
      interval_seconds: started.data.intervalSeconds,
      resumed: false,
    },
  };
}

/** Что ответил обмен кода. */
export type ClaimResult =
  | { ok: true; account_id: number; title: string; email: string; expires_at: string }
  | { ok: false; error: DeviceFlowError | 'not_found' | 'not_pending'; message?: string };

/**
 * Забрать токен: обменять подтверждённый код на пару и положить её в базу.
 *
 * Пока владелец не подтвердил — MiniMax отдаёт `authorization_pending`: это НЕ ошибка,
 * а «жди» (страница опрашивает раз в `interval_seconds`).
 */
export async function claimToken(
  user: SessionUser,
  flowId: number,
  now: Date = new Date(),
): Promise<ClaimResult> {
  const [flow] = await db
    .select()
    .from(accountTokenFlow)
    .where(
      and(
        eq(accountTokenFlow.id, flowId),
        ownership(user, accountTokenFlow.userId),
        eq(accountTokenFlow.state, 'pending'),
      ),
    )
    .limit(1);
  if (!flow) return { ok: false, error: 'not_found' };

  const deviceCode = decryptSecret(
    {
      ciphertext: flow.deviceCode,
      iv: flow.deviceCodeIv,
      authTag: flow.deviceCodeTag,
    },
    accountTokenFlowAad(flow.id),
  );
  const verifier = decryptSecret(
    {
      ciphertext: flow.codeVerifier,
      iv: flow.codeVerifierIv,
      authTag: flow.codeVerifierTag,
    },
    accountTokenFlowAad(flow.id),
  );

  const exchanged = await exchangeDeviceCode(deviceCode, verifier);
  if (!exchanged.ok) {
    if (exchanged.error === 'expired_token' || exchanged.error === 'access_denied') {
      await db
        .update(accountTokenFlow)
        .set({
          state: exchanged.error === 'expired_token' ? 'expired' : 'failed',
          updatedAt: now.toISOString(),
        })
        .where(eq(accountTokenFlow.id, flow.id));
    }
    return { ok: false, error: exchanged.error, message: exchanged.message };
  }

  const expiresAt = new Date(now.getTime() + exchanged.data.expiresInSeconds * 1000);
  const payload = JSON.stringify({
    access: exchanged.data.accessToken,
    refresh: exchanged.data.refreshToken,
  });
  const enc = encryptSecret(payload, accountTokenAad(flow.accountId));

  await db.transaction(async (tx) => {
    await tx
      .insert(accountToken)
      .values({
        userId: user.id,
        accountId: flow.accountId,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        expiresAt: expiresAt.toISOString(),
      })
      .onConflictDoUpdate({
        target: accountToken.accountId,
        set: {
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          authTag: enc.authTag,
          expiresAt: expiresAt.toISOString(),
          handedOverAt: null,
          updatedAt: now.toISOString(),
        },
      });
    await tx
      .update(accountTokenFlow)
      .set({ state: 'done', updatedAt: now.toISOString() })
      .where(eq(accountTokenFlow.id, flow.id));
  });

  const [account] = await db
    .select({ title: accountsAccount.title, email: accountsAccount.email })
    .from(accountsAccount)
    .where(eq(accountsAccount.id, flow.accountId))
    .limit(1);

  return {
    ok: true,
    account_id: flow.accountId,
    title: account?.title ?? '',
    email: account?.email ?? '',
    expires_at: expiresAt.toISOString(),
  };
}

/** Пара, которую отдаём проекту (однократно). */
export type TokenHandover = {
  access_token: string;
  refresh_token: string;
  expires_at_ms: number;
};

/**
 * Отдать пару проекту — **один раз**.
 *
 * Отдача помечается `handed_over_at`: после этого мы свой refresh НЕ крутим (refresh
 * одноразовый, цепочка одна). Если проект пришлёт обновлённую пару обратно (он её
 * обновил), приём снимает отметку — и отдать можно снова.
 */
export async function handoverTokenPair(accountId: number): Promise<TokenHandover | null> {
  const [row] = await db
    .select()
    .from(accountToken)
    .where(eq(accountToken.accountId, accountId))
    .limit(1);
  if (!row || row.handedOverAt) return null;

  const payload = JSON.parse(
    decryptSecret(
      { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag },
      accountTokenAad(accountId),
    ),
  ) as { access?: string; refresh?: string };
  if (!payload.access || !payload.refresh) return null;

  const now = new Date().toISOString();
  await db
    .update(accountToken)
    .set({ handedOverAt: now, updatedAt: now })
    .where(eq(accountToken.id, row.id));

  return {
    access_token: payload.access,
    refresh_token: payload.refresh,
    expires_at_ms: new Date(row.expiresAt).getTime(),
  };
}

/**
 * Принять обновлённую пару от проекта (он обновил refresh сам).
 *
 * Обмен «пара туда — обновлённая пара сюда» — единственный способ держать аккаунт
 * в обороте: refresh у MiniMax одноразовый, и кто его потратил, тот и держит цепочку.
 */
export async function acceptRefreshedPair(
  userId: number,
  accountId: number,
  pair: { accessToken: string; refreshToken: string; expiresInSeconds?: number },
  now: Date = new Date(),
): Promise<boolean> {
  const payload = JSON.stringify({ access: pair.accessToken, refresh: pair.refreshToken });
  const enc = encryptSecret(payload, accountTokenAad(accountId));
  const expiresAt = new Date(now.getTime() + (pair.expiresInSeconds ?? 3600) * 1000);

  // Upsert: пара может прийти и для аккаунта, у которого у нас строки нет (наши
  // данные могли потеряться) — терять цепочку нельзя ни в коем случае.
  await db
    .insert(accountToken)
    .values({
      userId,
      accountId,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      expiresAt: expiresAt.toISOString(),
    })
    .onConflictDoUpdate({
      target: accountToken.accountId,
      set: {
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        expiresAt: expiresAt.toISOString(),
        // Новая пара ещё не отдана — её можно отдать снова.
        handedOverAt: null,
        updatedAt: now.toISOString(),
      },
    });
  return true;
}

/**
 * id аккаунтов, чью пару токенов ещё можно отдать проекту.
 *
 * «Ещё можно» = пара добыта И не отдавалась после последнего обновления. Отдача
 * помечается `handed_over_at`, потому что refresh у MiniMax одноразовый: получив пару,
 * проект крутит refresh сам и присылает обновлённую пару обратно (приём снимает
 * отметку) — тогда отдать можно снова.
 */
export async function tokenReadyAccountIds(): Promise<number[]> {
  const rows = await db
    .select({ accountId: accountToken.accountId, handedOverAt: accountToken.handedOverAt })
    .from(accountToken);
  return rows.filter((row) => !row.handedOverAt).map((row) => row.accountId);
}

/** Отменить открытый flow (владелец передумал). */
export async function cancelTokenFlow(user: SessionUser, flowId: number): Promise<boolean> {
  const [row] = await db
    .update(accountTokenFlow)
    .set({ state: 'expired', updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(accountTokenFlow.id, flowId),
        ownership(user, accountTokenFlow.userId),
        eq(accountTokenFlow.state, 'pending'),
      ),
    )
    .returning({ id: accountTokenFlow.id });
  return row !== undefined;
}

/** Данные всплывающего окна «пароль от аккаунта». */
export type TokenWindowData = {
  accountId: number;
  title: string;
  email: string;
  /** Ссылка подтверждения MiniMax — запасной путь, если вкладка не открылась. */
  verificationLink: string | null;
};

/**
 * Данные для окна пароля — по id device-flow.
 *
 * Ссылка подтверждения берётся ИЗ СТРОКИ ПОТОКА, а не из адреса окна: код живёт
 * пять минут, и класть его в URL — значит оставлять его в журнале доступа.
 * Поэтому окно знает только `flow=<id>`, а всё остальное спрашивает у базы.
 */
export async function tokenWindowData(
  user: SessionUser,
  flowId: number,
): Promise<TokenWindowData | null> {
  const [row] = await db
    .select({
      accountId: accountTokenFlow.accountId,
      userCode: accountTokenFlow.userCode,
      verificationUri: accountTokenFlow.verificationUri,
      verificationUriComplete: accountTokenFlow.verificationUriComplete,
      title: accountsAccount.title,
      email: accountsAccount.email,
    })
    .from(accountTokenFlow)
    .innerJoin(accountsAccount, eq(accountsAccount.id, accountTokenFlow.accountId))
    .where(and(eq(accountTokenFlow.id, flowId), ownership(user, accountTokenFlow.userId)))
    .limit(1);
  if (!row) return null;

  return {
    accountId: row.accountId,
    title: row.title,
    email: row.email,
    verificationLink:
      row.verificationUriComplete ?? verificationLink(row.verificationUri, row.userCode),
  };
}

/** Проверка «есть ли у аккаунта токен» — используется в ручках выдачи. */
export async function hasToken(accountId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: accountToken.id })
    .from(accountToken)
    .where(eq(accountToken.accountId, accountId))
    .limit(1);
  return row !== undefined;
}
