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
  refreshAccessToken,
  startDeviceFlow,
  verificationLink,
  type DeviceFlowError,
} from '@/lib/minimax/oauth';

/**
 * Токены аккаунтов MiniMax: добыча через OAuth device-flow, оживление по refresh
 * и выдача проекту.
 *
 * ЗАКАЗ ВЛАДЕЛЬЦА (14.11): «напишешь скрипт-программу с веб-интерфейсом на кармане,
 * чтобы я туда зашел и просто щелкал кнопку "Следующий" и ты давал ссылку для
 * авторизации, я проходил авторизацию и скрипт забирал токен и клал его в базу для
 * этого аккаунта и так по кругу пока все аккаунты не пройду и не получу токены».
 *
 * ## Что такое «протухший» токен (15.11)
 *
 * Владелец: «никаких пар не надо делать, ты отдаешь по одному токену за один
 * запрос… забудь про пары токенов, мы по две штуки нигде не используем и никому не
 * даём. И оживи те токены которые названы протухшими, токены не протухли, протухло
 * их использование на эти сутки, завтра их можно снова использовать… на этой
 * странице может быть только два статуса — "Без токена" и "Токен получен", все».
 *
 * Значит:
 *
 * - **наружу уходит только access** — по одному за запрос; refresh остаётся у нас;
 * - **access протухает через 12 часов** (вендорский `expires_in = 43 200`), но
 *   это НЕ «нужен новый вход»: refresh одноразовый, однако вместе с новым access
 *   вендор отдаёт и новый refresh — цепочка продлевается (живая проба 15.11:
 *   HTTP 200, пришли оба токена). Значит протухший access мы оживляем САМИ
 *   (`ensureLiveAccessToken`);
 * - **в интерфейсе статуса ровно два**: «Без токена» и «Токен получен». «Пара
 *   протухла — нужен новый вход» было нашей выдумкой, и она пугала владельца.
 *
 * ## Правило одноразового refresh
 *
 * Refresh-токен у MiniMax одноразовый: повторное использование вендор считает
 * злоупотреблением и отзывает цепочку. Поэтому:
 *
 * - добытая пара хранится шифротекстом (ключ мастер-ключа vault, AAD — id аккаунта);
 * - наружу refresh не уходит НИКОГДА — цепочка наша, и продлеваем её мы;
 * - при оживлении refresh ПРОДЛЕВАЕТСЯ: вендор отдаёт новый refresh вместе с новым
 *   access, и мы кладём в базу новую пару целиком (старая цепочка оборвана).
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
 * Состояние аккаунта по токену — ровно ДВА, как просил владелец (15.11).
 *
 * `obtained` — пара есть (access жив или протух и оживляем по refresh);
 * `none` — пары нет, аккаунту нужен device-flow (вход владельца в MiniMax).
 *
 * Отдельно живёт флаг `pending` — идёт подтверждение кода. Это не «статус
 * токена», а состояние процесса, поэтому в колонке статуса он не показывается.
 */
export type AccountTokenState = 'none' | 'obtained';

export type AccountTokenRow = {
  account_id: number;
  title: string;
  email: string;
  state: AccountTokenState;
  /** Срок жизни access-токена (ISO) — когда он истечёт. */
  expires_at: string | null;
  /** Когда access последний раз отдали проекту (ISO) или null. */
  handed_over_at: string | null;
  /** Москва-дата последней активации аккаунта или null. */
  used_on: string | null;
  /** Годится ли аккаунт сегодня: бонус не сожжён, неделя не кончилась. */
  today_status: TokenTodayStatus;
  /** Очки, которые даст следующая активация этого аккаунта (400 или 1000). */
  points_next: number;
  /** Идёт ли по аккаунту device-flow (владелец ещё не подтвердил код). */
  pending: boolean;
};

/**
 * Состояние аккаунта «на сегодня» — важно для добычи токенов.
 *
 * `busy` — суточный бонус сожжён: ночной сброс у MiniMax после активации ещё не
 * наступил (мандат владельца 15.11). Такая пара сегодня проекту не нужна: бонус
 * до утра не восстановится.
 */
export type TokenTodayStatus = 'free' | 'burned' | 'busy' | 'week_exhausted';

export type TokenProgress = {
  total: number;
  /** Аккаунтов с добытой парой. */
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
    return {
      account_id: account.id,
      title: account.title,
      email: account.email,
      // Статусов ровно два (владелец, 15.11): пара есть — «Токен получен»,
      // пары нет — «Без токена». Протухший access — не «нужен новый вход»:
      // мы оживляем его по refresh (см. ensureLiveAccessToken).
      state: token ? 'obtained' : 'none',
      expires_at: token ? token.expiresAt : null,
      handed_over_at: token?.handedOverAt ?? null,
      used_on: account.usedOn,
      today_status: todayStatus(account),
      points_next: account.weekPointsNext,
      pending: pendingBy.has(account.id),
    };
  });

  const withToken = rows.filter((row) => row.state === 'obtained').length;
  const pending = rows.filter((row) => row.pending).length;

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
 * `busy` — суточный бонус сожжён (ночной сброс ещё не наступил): пара такому
 * аккаунту сегодня не нужна, бонус до утра не восстановится.
 */
function todayStatus(account: {
  weekCheckedInToday: boolean;
  spent: boolean;
  weekExhausted: boolean;
}): TokenTodayStatus {
  if (account.weekExhausted) return 'week_exhausted';
  if (account.spent) return 'busy';
  if (account.weekCheckedInToday) return 'burned';
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
 * **Порядок выбора — сначала те, у кого бонус сегодня ещё целы.** Добыча пары стоит
 * владельцу времени (device-flow, ~2 минуты на аккаунт), а у аккаунта с сожжённым
 * бонусом пара сегодня не пригодится никогда. Если таких аккаунтов не осталось —
 * берём любой (владелец идёт по кругу до конца, как и просил).
 *
 * `accountId` — начать flow для КОНКРЕТНОГО аккаунта (кнопка «Получить токен» в
 * строке и немедленная добыча после добавления аккаунта).
 */
export async function startNextTokenFlow(
  user: SessionUser,
  now: Date = new Date(),
  accountId?: number,
): Promise<
  | { ok: true; flow: NextTokenFlow }
  | { ok: false; error: 'complete' | 'oauth_failed' | 'not_found'; message?: string }
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

  // Конкретный аккаунт: висящий flow по ДРУГОМУ аккаунту — отменяем (владелец
  // выбрал другой), иначе он просто продолжится.
  if (accountId !== undefined) {
    const target = progress.rows.find((row) => row.account_id === accountId);
    if (!target) return { ok: false, error: 'not_found' };
    if (pendingFlow && pendingFlow.accountId !== accountId) {
      await db
        .update(accountTokenFlow)
        .set({ state: 'expired', updatedAt: now.toISOString() })
        .where(eq(accountTokenFlow.id, pendingFlow.id));
    } else if (pendingFlow) {
      const expiresAt = new Date(pendingFlow.expiresAt);
      if (expiresAt.getTime() > now.getTime()) {
        return {
          ok: true,
          flow: {
            flow_id: pendingFlow.id,
            account_id: pendingFlow.accountId,
            title: target.title,
            email: target.email,
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
      await db
        .update(accountTokenFlow)
        .set({ state: 'expired', updatedAt: now.toISOString() })
        .where(eq(accountTokenFlow.id, pendingFlow.id));
    }
    return startFlowFor(user, now, {
      account_id: target.account_id,
      title: target.title,
      email: target.email,
    });
  }

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

  // Кандидаты — аккаунты БЕЗ токена. Протухшая пара сюда не идёт: её мы оживляем
  // по refresh, новый вход владельцу не нужен (заказ 15.11).
  const candidates = progress.rows.filter((row) => row.state === 'none');
  // Порядок — по мандату владельца 14.11: **Сарафану четырехсотовые аккаунты в первую
  // очередь** (тысячные владелец оставляет себе под программирование), и очки у них
  // сегодня ещё не сожжены. Дальше — любые свободные.
  const next =
    candidates.find((row) => row.today_status === 'free' && row.points_next === 400) ??
    candidates.find((row) => row.today_status === 'free') ??
    candidates.find((row) => row.points_next === 400) ??
    candidates[0];
  if (!next) {
    return { ok: false, error: 'complete' };
  }
  return startFlowFor(user, now, {
    account_id: next.account_id,
    title: next.title,
    email: next.email,
  });
}

/** Завести device-flow для конкретного аккаунта и вернуть данные для подтверждения. */
async function startFlowFor(
  user: SessionUser,
  now: Date,
  account: { account_id: number; title: string; email: string },
): Promise<
  | { ok: true; flow: NextTokenFlow }
  | { ok: false; error: 'oauth_failed'; message?: string }
> {
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
      accountId: account.account_id,
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
      account_id: account.account_id,
      title: account.title,
      email: account.email,
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
 * Что отдаём проекту: **только access** (мандат владельца 15.11 — пара целиком не
 * отдаётся). Refresh остаётся у нас.
 */
export type AccessHandover = {
  access_token: string;
  expires_at_ms: number;
};

/**
 * Порог остатка жизни access, ниже которого отдавать его потребителю нельзя.
 *
 * Находка Мозга (17.11, «access с остатком 9 минут»): в 09:49 МСК мы отдали аккаунт,
 * у которого access истекал через 9 минут. Потребитель (десктоп) отверг токен и **стёр
 * запись входа** (`auth.json` 671 → 42 байта), а access одноразовый — вернуть его
 * нельзя, аккаунт при этом всё равно сгорал: минус один аккаунт пула вместо одного
 * выданного.
 *
 * Значит короткий остаток — не «почти работает», а брак: такой access отдавать нельзя.
 * Порог — 2 часа (Мозг просил именно два; у себя отсекал 30 минут). Лучше отдать
 * следующий аккаунт, чем отдать тот, который сдохнет у потребителя.
 *
 * Следствие для обеих ручек: и выдача, и продление цепочки при нехватке остатка
 * продлевают пару по refresh — «остаток 9 минут» становится невозможен в принципе.
 */
export const MIN_HANDOVER_ACCESS_LIFETIME_MS = 2 * 60 * 60 * 1000;

/** Сколько жизни осталось у access (мс). Отрицательное — он уже мёртв. */
export function accessLifetimeLeftMs(expiresAtMs: number, now: Date): number {
  return expiresAtMs - now.getTime();
}

/** Access протух или доживает до порога — отдавать его нельзя. */
export function accessTooShortToHandOver(expiresAtMs: number, now: Date): boolean {
  return accessLifetimeLeftMs(expiresAtMs, now) < MIN_HANDOVER_ACCESS_LIFETIME_MS;
}

/**
 * Продлить цепочку токенов аккаунта по refresh и положить новую пару в базу.
 *
 * Refresh одноразовый, но вендор вместе с новым access отдаёт и новый refresh — то
 * есть цепочка продлевается (живая проба 15.11: HTTP 200, оба токена).
 *
 * `handedOverAt` — что пометить в строке: `null` для пути выдачи (отдача помечается
 * позже, отдельным вызовом) и время — для пути продления (там отдача происходит
 * сразу). Оптимистичная блокировка по `ciphertext`: если пару в тот же момент
 * обновили (два проекта позвали продление одновременно), наша запись не должна
 * затереть чужую.
 *
 * null — refresh не сработал: цепочка оборвана (вендор больше не примет refresh) и
 * аккаунту нужен новый вход владельца. Пару удаляем, чтобы пул не предлагал
 * мёртвый аккаунт.
 */
async function refreshTokenChain(
  row: typeof accountToken.$inferSelect,
  refresh: string,
  now: Date,
  handedOverAt: string | null,
): Promise<{ access_token: string; expires_at_ms: number } | null> {
  const refreshed = await refreshAccessToken(refresh);
  if (!refreshed.ok) {
    if (refreshed.error === 'invalid_grant') {
      // Цепочка оборвана: refresh вендор больше не примет. Аккаунту нужен новый
      // вход — пара удаляется, а мы говорим об этом честно (null).
      await db.delete(accountToken).where(eq(accountToken.id, row.id));
    }
    return null;
  }

  const newExpiresAt = new Date(now.getTime() + refreshed.data.expiresInSeconds * 1000);
  const enc = encryptSecret(
    JSON.stringify({ access: refreshed.data.accessToken, refresh: refreshed.data.refreshToken }),
    accountTokenAad(row.accountId),
  );
  const updated = await db
    .update(accountToken)
    .set({
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      expiresAt: newExpiresAt.toISOString(),
      handedOverAt,
      updatedAt: now.toISOString(),
    })
    .where(and(eq(accountToken.id, row.id), eq(accountToken.ciphertext, row.ciphertext)))
    .returning({ id: accountToken.id });
  if (updated.length === 0) return null;

  return { access_token: refreshed.data.accessToken, expires_at_ms: newExpiresAt.getTime() };
}

/**
 * Живой access-токен аккаунта — с оживлением по refresh.
 *
 * Access живёт 12 часов (вендорский `expires_in = 43 200`). Протухший access — не
 * «нужен новый вход»: refresh одноразовый, но вместе с новым access вендор отдаёт и
 * новый refresh, то есть цепочка продлевается (живая проба 15.11: HTTP 200, оба
 * токена). Поэтому мы обновляем пару сами и кладём в базу новую целиком.
 *
 * **Короткий остаток — тоже брак.** Если access доживает меньше
 * `MIN_HANDOVER_ACCESS_LIFETIME_MS` (2 часа), мы его НЕ отдаём, а продлеваем цепочку:
 * отдать потребителю почти мёртвый токен значит угробить вход и сжечь аккаунт
 * (находка Мозга 17.11: access с остатком 9 минут → десктоп стёр `auth.json`).
 *
 * Возвращает null, если:
 *
 * - пары нет вовсе (аккаунту нужен device-flow);
 * - refresh не сработал и цепочка оборвана — тогда аккаунту нужен новый вход, и мы
 *   говорим об этом честно (в интерфейсе это «Без токена»);
 * - access жив, но его уже отдали: тот же вход двоим не нужен, баланс у аккаунта
 *   общий.
 */
export async function ensureLiveAccessToken(
  accountId: number,
  now: Date = new Date(),
): Promise<AccessHandover | null> {
  const [row] = await db
    .select()
    .from(accountToken)
    .where(eq(accountToken.accountId, accountId))
    .limit(1);
  if (!row) return null;

  let payload: { access?: string; refresh?: string };
  try {
    payload = JSON.parse(
      decryptSecret(
        { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag },
        accountTokenAad(accountId),
      ),
    ) as { access?: string; refresh?: string };
  } catch {
    // Пара не читается (повреждена или сменился мастер-ключ). Аккаунту нужен новый
    // вход, но данные мы не трогаем: молча переписать их нельзя.
    return null;
  }
  const access = payload.access;
  const refresh = payload.refresh;
  if (!access || !refresh) return null;

  const expiresAtMs = new Date(row.expiresAt).getTime();
  if (expiresAtMs > now.getTime()) {
    // Access УЖЕ отдан потребителю. Тот же токен ему второй раз не отдадим (тот же
    // вход двоим не нужен), но цепочку продолжим: refresh наш, и вендор отдаёт новую
    // пару. Новый access уходит новому потребителю — у него своя сессия, свои очки
    // он заберёт со своей клетки.
    //
    // ПОЧЕМУ НЕ «просто не отдавать» (живая находка 18.11, 21:00 МСК): аккаунт,
    // отданный потребителю сегодня, после возвращения в оборот (сторож) вставал в
    // начало списка — а отдать его было нечем: access отдан, значит второй раз его
    // не дать. Пул показывал 101 свободный аккаунт, а потребитель получал
    // «no_free_accounts»: из первых пяти кандидатов ни один не был выдаваем.
    //
    // ЧЕГО ЭТО СТОИТ: баланс у аккаунта общий. Если прежний потребитель ещё
    // работает, очки он уже потратил — новый получит аккаунт с нулевым балансом.
    // Отсюда пауза сторожа в полчаса (заказ владельца 18.11): последние полчаса
    // выдачи не трогаем, там ещё могут работать.
    if (row.handedOverAt) return refreshTokenChain(row, refresh, now, null);
    // Остаток меньше порога — отдавать нельзя (находка Мозга 17.11: access с 9
    // минутами остатка; десктоп стёр запись входа, аккаунт сгорел впустую).
    // Продлеваем цепочку по refresh — и отдаём уже свежий access.
    if (accessTooShortToHandOver(expiresAtMs, now)) {
      return refreshTokenChain(row, refresh, now, null);
    }
    return { access_token: access, expires_at_ms: expiresAtMs };
  }

  // Access мёртв — оживляем цепочку. Refresh одноразовый, поэтому вендор отдаёт
  // новый вместе с новым access: в базу кладём пару целиком.
  return refreshTokenChain(row, refresh, now, null);
}

/**
 * Живой access для ЧТЕНИЯ состояния суток (панель MiniMax).
 *
 * Отличие от `ensureLiveAccessToken`: отданный access тоже годится — прочитать
 * панель можно тем же токеном, который уже у потребителя. Refresh при этом не
 * тратится зря: цепочку обновляем только когда access протух (тогда refresh и
 * был бы использован один раз — и даёт новую пару).
 */
export async function liveAccessToken(
  accountId: number,
  now: Date = new Date(),
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(accountToken)
    .where(eq(accountToken.accountId, accountId))
    .limit(1);
  if (!row) return null;

  let payload: { access?: string; refresh?: string };
  try {
    payload = JSON.parse(
      decryptSecret(
        { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag },
        accountTokenAad(accountId),
      ),
    ) as { access?: string; refresh?: string };
  } catch {
    return null;
  }
  if (!payload.access || !payload.refresh) return null;

  if (new Date(row.expiresAt).getTime() > now.getTime()) return payload.access;

  // Access протух — продлеваем цепочку (refresh одноразовый, но выдаёт новую пару).
  const refreshed = await refreshAccessToken(payload.refresh);
  if (!refreshed.ok) {
    if (refreshed.error === 'invalid_grant') {
      await db.delete(accountToken).where(eq(accountToken.id, row.id));
    }
    return null;
  }

  const newExpiresAt = new Date(now.getTime() + refreshed.data.expiresInSeconds * 1000);
  const enc = encryptSecret(
    JSON.stringify({ access: refreshed.data.accessToken, refresh: refreshed.data.refreshToken }),
    accountTokenAad(accountId),
  );
  const updated = await db
    .update(accountToken)
    .set({
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      expiresAt: newExpiresAt.toISOString(),
      handedOverAt: null,
      updatedAt: now.toISOString(),
    })
    .where(and(eq(accountToken.id, row.id), eq(accountToken.ciphertext, row.ciphertext)))
    .returning({ id: accountToken.id });
  if (updated.length === 0) return null;
  return refreshed.data.accessToken;
}

/**
 * Продление цепочки токенов аккаунта (D-219, мандат владельца 17.11).
 *
 * Отличие от `ensureLiveAccessToken`: там access, который уже отдан проекту, второй
 * раз не отдаётся («тот же вход двоим не нужен, баланс у аккаунта общий»). Здесь
 * отдаём СНОВА — тому же потребителю, который пришёл за продолжением: по мандату
 * brain'а «продление — это тот же аккаунт и тот же потребитель», а один аккаунт —
 * один потребитель ([G627]).
 *
 * - **access жив и полон** (остаток ≥ `MIN_HANDOVER_ACCESS_LIFETIME_MS`) → отдаём тот
 *   же самый, refresh не трогаем: он одноразовый, а жечь его ради запроса «дай ещё
 *   раз» незачем;
 * - **access протух ИЛИ доживает меньше порога** (2 часа) → продлеваем цепочку: вендор
 *   отдаёт новую пару целиком, кладём её в базу и отдаём новый access. **Refresh наружу
 *   не уходит никогда** — цепочка наша (мандат владельца 14.11, D-219). Короткий
 *   остаток продлеваем, а не отдаём: иначе потребитель остаётся с почти мёртвым
 *   токеном (находка Мозга 17.11: остаток 9 минут → десктоп стёр запись входа).
 *
 * null — пары нет вовсе или цепочка оборвана (вендор больше не принимает refresh):
 * аккаунту нужен новый вход, а это делает владелец (device-flow), не проект.
 */
export type RenewedAccess = {
  access_token: string;
  expires_at_ms: number;
  /** true — цепочку продлили новой парой; false — access ещё жил, отдали тот же. */
  renewed: boolean;
  /**
   * Сколько жизни оставалось у ПРЕДЫДУЩЕГО access в момент продления (мс).
   * Отрицательное — он уже протух. Нужен для разбора: почему цепочку продлили и
   * сколько жил выданный токен (письмо Мозга 17.11).
   */
  previous_left_ms: number;
};

export async function renewAccountToken(
  accountId: number,
  now: Date = new Date(),
): Promise<RenewedAccess | null> {
  const [row] = await db
    .select()
    .from(accountToken)
    .where(eq(accountToken.accountId, accountId))
    .limit(1);
  if (!row) return null;

  let payload: { access?: string; refresh?: string };
  try {
    payload = JSON.parse(
      decryptSecret(
        { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag },
        accountTokenAad(accountId),
      ),
    ) as { access?: string; refresh?: string };
  } catch {
    // Пара не читается (повреждена или сменился мастер-ключ): молча переписать её
    // нельзя — аккаунту нужен новый вход, и это должен сделать владелец.
    return null;
  }
  const access = payload.access;
  const refresh = payload.refresh;
  if (!access || !refresh) return null;

  const expiresAtMs = new Date(row.expiresAt).getTime();
  const previousLeftMs = accessLifetimeLeftMs(expiresAtMs, now);
  if (expiresAtMs > now.getTime() && !accessTooShortToHandOver(expiresAtMs, now)) {
    // Access ещё жив и полон — отдаём его же. Отдача помечается: пара у этого
    // потребителя.
    await markAccessHandedOver(accountId, now);
    return {
      access_token: access,
      expires_at_ms: expiresAtMs,
      renewed: false,
      previous_left_ms: previousLeftMs,
    };
  }

  // Access протух ИЛИ доживает до порога (остаток < 2 часов — отдавать нельзя,
  // находка Мозга 17.11). В обоих случаях цепочку продлеваем: refresh одноразовый,
  // но вендор отдаёт новую пару целиком. Отдача помечается сразу — она происходит
  // сейчас, потребитель уходит с этим access.
  const refreshed = await refreshTokenChain(row, refresh, now, now.toISOString());
  if (!refreshed) return null;

  return {
    access_token: refreshed.access_token,
    expires_at_ms: refreshed.expires_at_ms,
    renewed: true,
    previous_left_ms: previousLeftMs,
  };
}

/**
 * Пометить, что access отдан проекту (мандат владельца 15.11: по одному токену за
 * один запрос).
 */
export async function markAccessHandedOver(
  accountId: number,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(accountToken)
    .set({ handedOverAt: now.toISOString(), updatedAt: now.toISOString() })
    .where(eq(accountToken.accountId, accountId));
}

/**
 * id аккаунтов, у которых пара токенов есть.
 *
 * Такой аккаунт годится для выдачи всегда: протухший access мы оживим по refresh
 * при выдаче (`ensureLiveAccessToken`). Не годится только тот, у кого цепочка
 * оборвана — там мы честно скажем «без токена».
 */
export async function tokenBackedAccountIds(): Promise<number[]> {
  const rows = await db.select({ accountId: accountToken.accountId }).from(accountToken);
  return rows.map((row) => row.accountId);
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
