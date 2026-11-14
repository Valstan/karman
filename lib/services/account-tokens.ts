import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { accountToken, accountTokenFlow, accountsAccount } from '@/lib/db/schema';
import { ownership, type SessionUser } from '@/lib/auth/rbac';
import { decryptSecret, encryptSecret } from '@/lib/secrets/crypto';
import { listAccounts } from '@/lib/services/accounts';
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

/**
 * Состояние аккаунта в процессе добычи токенов.
 *
 * `expired` — access истёк (он живёт 12 часов): токен мёртв, проект отдавать ему
 * нечего, аккаунту нужен новый вход. Отдельно от `handed_over`: тот access жив, просто
 * уже у проекта.
 */
export type AccountTokenState = 'none' | 'pending' | 'stored' | 'handed_over' | 'expired';

export type AccountTokenRow = {
  account_id: number;
  title: string;
  email: string;
  state: AccountTokenState;
  /** Срок жизни access-токена (ISO) — когда он истечёт. */
  expires_at: string | null;
  /** Когда пару отдали проекту (ISO) или null. */
  handed_over_at: string | null;
  /** Москва-дата последней активации аккаунта или null. */
  used_on: string | null;
  /** Годится ли пара проекту сегодня: очки не сожжены, аккаунт не занят, неделя не кончилась. */
  today_status: TokenTodayStatus;
  /** Очки, которые даст следующая активация этого аккаунта (400 или 1000). */
  points_next: number;
};

/**
 * Состояние аккаунта «на сегодня» — важно для добычи токенов.
 *
 * Пара, добытая владельцем для аккаунта, чьи очки сегодня уже сожжены, проекту
 * бесполезна: активировать его сегодня уже нельзя, а пара живёт 12 часов и завтра
 * сгорит. Поэтому «Следующий» сначала берёт аккаунты, у которых очки целы.
 */
export type TokenTodayStatus = 'free' | 'burned' | 'busy' | 'week_exhausted';

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
export async function tokenProgress(
  user: SessionUser,
  now: Date = new Date(),
): Promise<TokenProgress> {
  // Список аккаунтов — тот же, что видит владелец в панели (`listAccounts`): с
  // окном простоя и недельной квотой. Отсюда и «годится ли пара сегодня».
  const [accounts, flows, tokens] = await Promise.all([
    listAccounts(user, now),
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
    // Access живёт 12 часов. Протухший — мёртвый: проект получил бы битый вход, а мы
    // продлить его не можем (refresh одноразовый и остаётся у нас). Значит аккаунту
    // нужен новый вход — и неважно, отдавали мы access или нет.
    const tokenDead =
      token !== undefined && new Date(token.expiresAt).getTime() <= now.getTime();
    const state: AccountTokenState = token
      ? tokenDead
        ? 'expired'
        : token.handedOverAt
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
      used_on: account.usedOn,
      today_status: todayStatus(account),
      points_next: account.weekPointsNext,
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
 * Состояние аккаунта «на сегодня» для добычи токенов.
 *
 * `burned` — очки за сегодня уже сожжены (чек-ин был): пара такому аккаунту
 * сегодня не нужна, а за завтра она всё равно сгорит (access живёт 12 часов).
 */
function todayStatus(account: {
  weekCheckedInToday: boolean;
  spent: boolean;
  weekExhausted: boolean;
}): TokenTodayStatus {
  if (account.weekExhausted) return 'week_exhausted';
  if (account.weekCheckedInToday) return 'burned';
  if (account.spent) return 'busy';
  return 'free';
}

/**
 * «Следующий» — следующий аккаунт без токена.
 *
 * Если на аккаунте уже висит живой (не истёкший) device-flow — возвращаем его:
 * владелец мог просто не успеть подтвердить, и начинать заново с другим аккаунтом
 * означало бы оставлять висящие коды. Аккаунты с уже добытым токеном пропускаются
 * (заказ владельца: «если у аккаунта уже есть токен, то его пропустить»).
 *
 * **Порядок выбора — сначала те, у кого очки сегодня ещё целы.** Добыча пары стоит
 * владельцу времени (device-flow, ~2 минуты на аккаунт), и пара живёт 12 часов, а
 * у аккаунта, отмеченного сегодня, очки уже сожжены — такая пара проекту не
 * пригодится никогда. Если таких аккаунтов не осталось — берём любой (владелец
 * идёт по кругу до конца, как и просил).
 */
export async function startNextTokenFlow(
  user: SessionUser,
  now: Date = new Date(),
): Promise<
  | { ok: true; flow: NextTokenFlow }
  | { ok: false; error: 'complete' | 'oauth_failed'; message?: string }
> {
  const progress = await tokenProgress(user, now);

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

  const candidates = progress.rows.filter(
    (row) => row.state === 'none' || row.state === 'expired',
  );
  // Порядок — по мандату владельца 14.11: **Сарафану четырехсотовые аккаунты в первую
  // очередь** (тысячные владелец оставляет себе под программирование), и очки у них
  // сегодня ещё не сожжены. Дальше — любые свободные, в конце — протухшие.
  // «expired» — access умер и его никто не забрал: аккаунт надо добыть заново.
  const next =
    candidates.find((row) => row.today_status === 'free' && row.points_next === 400) ??
    candidates.find((row) => row.today_status === 'free') ??
    candidates.find((row) => row.points_next === 400) ??
    candidates[0];
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

/**
 * Что отдаём проекту: **только access** (мандат владельца 14.11 — пара целиком не
 * отдаётся). Refresh остаётся у нас.
 */
export type AccessHandover = {
  access_token: string;
  expires_at_ms: number;
};

/**
 * Access-токен, который отдаём проекту, — **один раз** за жизнь пары.
 *
 * **Мандат владельца 14.11:** пара целиком не отдаётся — «отдавай ему только по одному
 * токену». Поэтому наружу уходит **только access**; refresh (одноразовый) остаётся у
 * нас, и второй раз отдать его проект не должен.
 *
 * Отдача помечается `handed_over_at`: после этого мы свой refresh НЕ крутим (refresh
 * одноразовый, цепочка одна). Если проект пришлёт обновлённую пару обратно (он её
 * обновил), приём снимает отметку — и отдать можно снова.
 *
 * **Протухший access не отдаём:** он живёт 12 часов, а продлить его без refresh мы не
 * можем — отдать мёртвый токен значит отдать проекту сломанный вход.
 */
export async function handoverAccessToken(
  accountId: number,
  now: Date = new Date(),
): Promise<AccessHandover | null> {
  const [row] = await db
    .select()
    .from(accountToken)
    .where(eq(accountToken.accountId, accountId))
    .limit(1);
  if (!row || row.handedOverAt) return null;
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return null;

  const payload = JSON.parse(
    decryptSecret(
      { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag },
      accountTokenAad(accountId),
    ),
  ) as { access?: string; refresh?: string };
  if (!payload.access || !payload.refresh) return null;

  const handedOverAt = now.toISOString();
  await db
    .update(accountToken)
    .set({ handedOverAt, updatedAt: handedOverAt })
    .where(eq(accountToken.id, row.id));

  // Refresh из расшифрованной пары наружу НЕ уходит (мандат владельца — один токен):
  // цепочка токенов наша, её продлением занимаемся мы, а не потребитель.
  return {
    access_token: payload.access,
    expires_at_ms: new Date(row.expiresAt).getTime(),
  };
}


/**
 * id аккаунтов, чей access ещё можно отдать проекту.
 *
 * «Ещё можно» = пара добыта, ещё не отдана **и не протухла**. Отдача помечается
 * `handed_over_at`: access одноразово уходит проекту, а refresh остаётся у нас
 * (цепочка наша — её продлением занимаемся мы, а не потребитель).
 *
 * **Протухшая пара в раздачу не идёт:** access живёт 12 часов, а наш refresh мы не
 * крутим (цепочка одна) — отдать мёртвый токен значит отдать проекту сломанный вход.
 */
export async function tokenReadyAccountIds(now: Date = new Date()): Promise<number[]> {
  const rows = await db
    .select({
      accountId: accountToken.accountId,
      handedOverAt: accountToken.handedOverAt,
      expiresAt: accountToken.expiresAt,
    })
    .from(accountToken);
  return rows
    .filter(
      (row) =>
        !row.handedOverAt && new Date(row.expiresAt).getTime() > now.getTime(),
    )
    .map((row) => row.accountId);
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
