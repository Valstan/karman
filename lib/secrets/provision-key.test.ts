import { afterEach, describe, expect, it } from 'vitest';
import { checkProvisionKey, provisionKeyConfigured } from './provision-key';

const KEY = 'k'.repeat(40);

afterEach(() => {
  delete process.env.VAULT_PROVISION_KEY;
});

describe('provisionKeyConfigured', () => {
  it('false без env', () => {
    expect(provisionKeyConfigured()).toBe(false);
  });

  it('false при коротком ключе (слабый = не сконфигурирован)', () => {
    process.env.VAULT_PROVISION_KEY = 'short';
    expect(provisionKeyConfigured()).toBe(false);
  });

  it('true при ключе достаточной длины', () => {
    process.env.VAULT_PROVISION_KEY = KEY;
    expect(provisionKeyConfigured()).toBe(true);
  });
});

describe('checkProvisionKey', () => {
  it('false без сконфигурированного ключа (даже при совпадении со слабым env)', () => {
    process.env.VAULT_PROVISION_KEY = 'short';
    expect(checkProvisionKey('short')).toBe(false);
  });

  it('true при точном совпадении', () => {
    process.env.VAULT_PROVISION_KEY = KEY;
    expect(checkProvisionKey(KEY)).toBe(true);
  });

  it('false при несовпадении и при кандидате другой длины', () => {
    process.env.VAULT_PROVISION_KEY = KEY;
    expect(checkProvisionKey('x'.repeat(40))).toBe(false);
    expect(checkProvisionKey('x')).toBe(false);
  });

  it('учитывает пробелы по краям env-значения (trim)', () => {
    process.env.VAULT_PROVISION_KEY = `  ${KEY}  `;
    expect(checkProvisionKey(KEY)).toBe(true);
  });
});
