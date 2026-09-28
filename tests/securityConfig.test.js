import { afterEach, describe, expect, it } from 'vitest';
import { checkEncryptionKey, decryptSecret, encryptSecret } from '../src/lib/encryption.js';
import { checkJwtSecret } from '../src/lib/jwt.js';

const originalJwtSecret = process.env.JWT_SECRET;
const originalEncryptionKey = process.env.TOTP_ENCRYPTION_KEY;

afterEach(() => {
  process.env.JWT_SECRET = originalJwtSecret;
  process.env.TOTP_ENCRYPTION_KEY = originalEncryptionKey;
});

describe('checkJwtSecret', () => {
  it('refuse un secret absent ou de moins de 32 caractères', () => {
    process.env.JWT_SECRET = '';
    expect(() => checkJwtSecret()).toThrow('JWT_SECRET');
    process.env.JWT_SECRET = 'secret';
    expect(() => checkJwtSecret()).toThrow('au moins 32 caractères');
  });

  it('accepte un secret de 32 caractères', () => {
    process.env.JWT_SECRET = 'a'.repeat(32);
    expect(() => checkJwtSecret()).not.toThrow();
  });
});

describe('chiffrement des secrets 2FA', () => {
  it('refuse une clé qui ne fait pas 64 caractères hexadécimaux', () => {
    process.env.TOTP_ENCRYPTION_KEY = 'trop-courte';
    expect(() => checkEncryptionKey()).toThrow('TOTP_ENCRYPTION_KEY');
    process.env.TOTP_ENCRYPTION_KEY = 'z'.repeat(64);
    expect(() => checkEncryptionKey()).toThrow('TOTP_ENCRYPTION_KEY');
  });

  it('retrouve le secret après chiffrement, sans le laisser apparaître', () => {
    const encryptedSecret = encryptSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    expect(encryptedSecret).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(encryptedSecret)).toBe('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
  });

  it('produit un résultat différent à chaque chiffrement (IV aléatoire)', () => {
    expect(encryptSecret('MEMESECRET')).not.toBe(encryptSecret('MEMESECRET'));
  });

  it('détecte une valeur modifiée en base', () => {
    const [iv, authTag, encryptedPart] = encryptSecret('JBSWY3DPEHPK3PXP').split('.');
    const tamperedPart = `${encryptedPart.startsWith('A') ? 'B' : 'A'}${encryptedPart.slice(1)}`;
    expect(() => decryptSecret([iv, authTag, tamperedPart].join('.'))).toThrow();
  });

  it('ne déchiffre pas avec une autre clé', () => {
    const encryptedSecret = encryptSecret('JBSWY3DPEHPK3PXP');
    process.env.TOTP_ENCRYPTION_KEY = 'f'.repeat(64);
    expect(() => decryptSecret(encryptedSecret)).toThrow();
  });
});
