import { describe, expect, it } from 'vitest';
import {
  normalizeEmail,
  validateEmail,
  validateLoginBody,
  validateNewPassword,
  validatePassword,
} from '../src/validators/authValidator.js';

describe('normalizeEmail', () => {
  it('retire les espaces et passe en minuscules', () => {
    expect(normalizeEmail('  Alice@Coedit.FR ')).toBe('alice@coedit.fr');
  });
});

describe('validateEmail', () => {
  it("renvoie l'email normalisé", () => {
    expect(validateEmail(' Alice@Coedit.fr')).toBe('alice@coedit.fr');
  });

  it.each([undefined, null, 42, '', '   '])('refuse une valeur absente ou non textuelle (%s)', (rawEmail) => {
    expect(() => validateEmail(rawEmail)).toThrow("L'email est obligatoire");
  });

  it.each(['alice', 'alice@', '@coedit.fr', 'alice@coedit', 'ali ce@coedit.fr'])('refuse un format invalide (%s)', (rawEmail) => {
    expect(() => validateEmail(rawEmail)).toThrow("Format d'email invalide");
  });

  it('refuse un email de plus de 255 caractères', () => {
    expect(() => validateEmail(`${'a'.repeat(250)}@coedit.fr`)).toThrow("Format d'email invalide");
  });
});

describe('validatePassword', () => {
  it('accepte un mot de passe simple (pas de règle de robustesse à la connexion)', () => {
    expect(validatePassword('abc')).toBe('abc');
  });

  it.each([undefined, null, 42, ''])('refuse une valeur absente ou non textuelle (%s)', (rawPassword) => {
    expect(() => validatePassword(rawPassword)).toThrow('Le mot de passe est obligatoire');
  });

  it('refuse un mot de passe de plus de 72 octets (limite de bcrypt)', () => {
    expect(() => validatePassword('a'.repeat(73))).toThrow('Mot de passe trop long');
    // 37 caractères accentués = 74 octets en UTF-8
    expect(() => validatePassword('é'.repeat(37))).toThrow('Mot de passe trop long');
  });
});

describe('validateNewPassword', () => {
  it('accepte un mot de passe robuste', () => {
    expect(validateNewPassword('MotDePasse1!')).toBe('MotDePasse1!');
  });

  it.each([
    ['trop court', 'Ab1!'],
    ['sans minuscule', 'MOTDEPASSE1!'],
    ['sans majuscule', 'motdepasse1!'],
    ['sans chiffre', 'MotDePasse!'],
    ['sans caractère spécial', 'MotDePasse1'],
  ])('refuse un mot de passe %s', (_, rawPassword) => {
    expect(() => validateNewPassword(rawPassword)).toThrow(/au moins 8 caractères/);
  });
});

describe('validateLoginBody', () => {
  it('renvoie email normalisé et mot de passe', () => {
    expect(validateLoginBody({ email: 'Alice@Coedit.fr', password: 'x' })).toEqual({
      email: 'alice@coedit.fr',
      password: 'x',
    });
  });

  it('refuse un corps absent', () => {
    expect(() => validateLoginBody(undefined)).toThrow("L'email est obligatoire");
  });
});
