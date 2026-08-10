import { afterEach, describe, expect, it } from 'vitest';
import { checkProvisionKey, provisionKeyConfigured } from './provision-key';

const KEY = 'k'.repeat(40);

afterEach(() => {
  delete process.env.VAULT_PROVISION_KEY;
  delete process.env.PROVISION_KEY_ENABLED;
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

  // Break-glass ADR-0012 §7: волна 5 гасит общий ключ переменной, без выкатки кода.
  it('false при явном PROVISION_KEY_ENABLED=false, даже с валидным ключом', () => {
    process.env.VAULT_PROVISION_KEY = KEY;
    process.env.PROVISION_KEY_ENABLED = 'false';
    expect(provisionKeyConfigured()).toBe(false);
    expect(checkProvisionKey(KEY)).toBe(false);
  });

  it('true при PROVISION_KEY_ENABLED=true и при незаданном флаге', () => {
    process.env.VAULT_PROVISION_KEY = KEY;
    process.env.PROVISION_KEY_ENABLED = 'true';
    expect(provisionKeyConfigured()).toBe(true);
    delete process.env.PROVISION_KEY_ENABLED;
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
