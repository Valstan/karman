import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet, type JWK } from 'jose';
import { verifyAssertion, type IssuerConfig } from './verify';

/**
 * Приёмка верификатора паспорта. Каждый негатив соответствует конкретной
 * границе из ADR-0012 §5 — это не «покрытие ради покрытия»: набор проверок
 * пришёл из адверсариальной проверки, и молча выпасть он не должен.
 */

const ISSUER: IssuerConfig = {
  issuer: 'https://token.actions.githubusercontent.com',
  audience: 'karman-vault',
  subjectPattern: '^repo:[^:/]+/[^:/]+:ref:refs/heads/(main|master)$',
  identityClaim: 'repository_id',
};

const NOW = new Date('2026-08-10T12:00:00Z');
const KID = 'test-key-1';
const GOOD_SUB = 'repo:Valstan/trener:ref:refs/heads/main';

let privateKey: CryptoKey;
let jwks: JSONWebKeySet;
/** Ключ ЧУЖОГО issuer'а: подпись верная, но ключа нет в нашем наборе. */
let alienKey: CryptoKey;

type Claims = Record<string, unknown>;

async function sign(
  claims: Claims = {},
  opts: { alg?: string; kid?: string | null; key?: CryptoKey; issuedAt?: Date } = {},
): Promise<string> {
  const iat = opts.issuedAt ?? NOW;
  const header: { alg: string; kid?: string } = { alg: opts.alg ?? 'RS256' };
  if (opts.kid !== null) header.kid = opts.kid ?? KID;

  return new SignJWT({
    repository_id: '424242',
    runner_environment: 'github-hosted',
    ...claims,
  })
    .setProtectedHeader(header)
    .setIssuer(ISSUER.issuer)
    .setAudience(ISSUER.audience)
    .setSubject(typeof claims.sub === 'string' ? claims.sub : GOOD_SUB)
    .setJti(typeof claims.jti === 'string' ? claims.jti : 'assertion-1')
    .setIssuedAt(iat)
    .setExpirationTime(new Date(iat.getTime() + 10 * 60_000))
    .sign(opts.key ?? privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  const pub = (await exportJWK(pair.publicKey)) as JWK;
  jwks = { keys: [{ ...pub, kid: KID, alg: 'RS256', use: 'sig' }] };
  alienKey = (await generateKeyPair('RS256', { extractable: true })).privateKey;
});

describe('verifyAssertion — принимает', () => {
  it('валидное удостоверение с основной ветки и отдаёт принципала', async () => {
    const res = await verifyAssertion(await sign(), ISSUER, jwks, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.principal).toMatchObject({
      kind: 'ci',
      identityValue: '424242',
      subject: GOOD_SUB,
      jti: 'assertion-1',
    });
    expect(res.principal.expiresAtMs).toBe(NOW.getTime() + 10 * 60_000);
  });

  it('числовой repository_id — приводит к строке (GitHub шлёт его числом)', async () => {
    const res = await verifyAssertion(await sign({ repository_id: 424242 }), ISSUER, jwks, NOW);
    expect(res.ok && res.principal.identityValue).toBe('424242');
  });

  it('master как основную ветку', async () => {
    const sub = 'repo:Valstan/legacy:ref:refs/heads/master';
    const res = await verifyAssertion(await sign({ sub }), ISSUER, jwks, NOW);
    expect(res.ok).toBe(true);
  });

  it('удостоверение без claim runner_environment (issuer, который его не шлёт)', async () => {
    const res = await verifyAssertion(
      await sign({ runner_environment: undefined }),
      ISSUER,
      jwks,
      NOW,
    );
    expect(res.ok).toBe(true);
  });
});

describe('verifyAssertion — отвергает', () => {
  it('подпись HS256 публичным ключом из JWKS (подмена alg)', async () => {
    // Ручная сборка: SignJWT с HS-ключом требует симметричного секрета, а
    // атака ровно в том, чтобы выдать публичную половину за секрет подписи.
    const { createHmac } = await import('node:crypto');
    const key = jwks.keys[0]!;
    const head = Buffer.from(JSON.stringify({ alg: 'HS256', kid: KID })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        iss: ISSUER.issuer,
        aud: ISSUER.audience,
        sub: GOOD_SUB,
        jti: 'hs-1',
        repository_id: '424242',
        iat: Math.floor(NOW.getTime() / 1000),
        exp: Math.floor(NOW.getTime() / 1000) + 600,
      }),
    ).toString('base64url');
    const sig = createHmac('sha256', String(key.n)).update(`${head}.${body}`).digest('base64url');

    const res = await verifyAssertion(`${head}.${body}.${sig}`, ISSUER, jwks, NOW);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toBe('alg_not_allowed');
  });

  it('заголовок без kid', async () => {
    const res = await verifyAssertion(await sign({}, { kid: null }), ISSUER, jwks, NOW);
    expect(!res.ok && res.reason).toBe('kid_missing');
  });

  it('подпись чужим ключом', async () => {
    const res = await verifyAssertion(await sign({}, { key: alienKey }), ISSUER, jwks, NOW);
    expect(!res.ok && res.reason).toBe('bad_signature');
  });

  it('чужой audience (удостоверение, выписанное другому сервису)', async () => {
    const other = { ...ISSUER, audience: 'setka-gateway' };
    const res = await verifyAssertion(await sign(), other, jwks, NOW);
    expect(!res.ok && res.reason).toBe('bad_signature');
  });

  it('чужой issuer', async () => {
    const other = { ...ISSUER, issuer: 'https://evil.example/oidc' };
    const res = await verifyAssertion(await sign(), other, jwks, NOW);
    expect(!res.ok && res.reason).toBe('bad_signature');
  });

  it('удостоверение старше maxTokenAge, хотя exp ещё не наступил', async () => {
    const old = new Date(NOW.getTime() - 20 * 60_000); // iat −20 мин, exp +10 мин от iat
    const res = await verifyAssertion(
      await sign({}, { issuedAt: old }),
      ISSUER,
      jwks,
      new Date(old.getTime() + 8 * 60_000),
    );
    expect(!res.ok && res.reason).toBe('bad_signature');
  });

  it('ветку, отличную от основной (ветки, PR и форки личность не минтят)', async () => {
    const res = await verifyAssertion(
      await sign({ sub: 'repo:Valstan/trener:ref:refs/heads/feature/x' }),
      ISSUER,
      jwks,
      NOW,
    );
    expect(!res.ok && res.reason).toBe('subject_not_allowed');
  });

  it('pull_request-окружение (форк минтил бы личность цели)', async () => {
    const res = await verifyAssertion(
      await sign({ sub: 'repo:Valstan/trener:pull_request' }),
      ISSUER,
      jwks,
      NOW,
    );
    expect(!res.ok && res.reason).toBe('subject_not_allowed');
  });

  it('self-hosted раннер', async () => {
    const res = await verifyAssertion(
      await sign({ runner_environment: 'self-hosted' }),
      ISSUER,
      jwks,
      NOW,
    );
    expect(!res.ok && res.reason).toBe('runner_untrusted');
  });

  it('удостоверение без jti (одноразовость недостижима)', async () => {
    const raw = await new SignJWT({ repository_id: '424242', runner_environment: 'github-hosted' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER.issuer)
      .setAudience(ISSUER.audience)
      .setSubject(GOOD_SUB)
      .setIssuedAt(NOW)
      .setExpirationTime(new Date(NOW.getTime() + 600_000))
      .sign(privateKey);
    const res = await verifyAssertion(raw, ISSUER, jwks, NOW);
    expect(!res.ok && res.reason).toBe('jti_missing');
  });

  it('удостоверение без claim личности', async () => {
    const res = await verifyAssertion(
      await sign({ repository_id: undefined }),
      ISSUER,
      jwks,
      NOW,
    );
    expect(!res.ok && res.reason).toBe('identity_claim_missing');
  });

  it('невалидный subject_pattern в строке реестра — отказ, а не исключение', async () => {
    const broken = { ...ISSUER, subjectPattern: '^repo:(' };
    const res = await verifyAssertion(await sign(), broken, jwks, NOW);
    expect(!res.ok && res.reason).toBe('issuer_pattern_invalid');
  });

  it('мусор вместо JWT', async () => {
    const res = await verifyAssertion('не-jwt-вовсе', ISSUER, jwks, NOW);
    expect(!res.ok && res.reason).toBe('malformed');
  });
});
