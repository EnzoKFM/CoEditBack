import { describe, expect, it } from 'vitest';
import {
  InvalidOperationError,
  applyOperation,
  parseOperation,
  transformIndex,
  transformOperation,
} from '../src/collaboration/textOperation.js';

describe('parseOperation', () => {
  it("refuse une opération qui n'est pas une liste", () => {
    expect(() => parseOperation('retain:5')).toThrow(InvalidOperationError);
    expect(() => parseOperation({ retain: 5 })).toThrow(InvalidOperationError);
    expect(() => parseOperation(null)).toThrow(InvalidOperationError);
  });

  it('refuse un composant avec plusieurs clés', () => {
    expect(() => parseOperation([{ retain: 1, insert: 'a' }])).toThrow(InvalidOperationError);
  });

  it('refuse un composant sans clé reconnue', () => {
    expect(() => parseOperation([{}])).toThrow(InvalidOperationError);
    expect(() => parseOperation([{ foo: 1 }])).toThrow(InvalidOperationError);
  });

  it('refuse un retain non entier ou négatif ou nul', () => {
    expect(() => parseOperation([{ retain: 0 }])).toThrow(InvalidOperationError);
    expect(() => parseOperation([{ retain: -1 }])).toThrow(InvalidOperationError);
    expect(() => parseOperation([{ retain: 1.5 }])).toThrow(InvalidOperationError);
  });

  it('refuse un insert vide ou non textuel', () => {
    expect(() => parseOperation([{ insert: '' }])).toThrow(InvalidOperationError);
    expect(() => parseOperation([{ insert: 42 }])).toThrow(InvalidOperationError);
  });

  it('refuse un delete non entier ou négatif ou nul', () => {
    expect(() => parseOperation([{ delete: 0 }])).toThrow(InvalidOperationError);
    expect(() => parseOperation([{ delete: -1 }])).toThrow(InvalidOperationError);
    expect(() => parseOperation([{ delete: 2.5 }])).toThrow(InvalidOperationError);
  });

  it('fusionne deux retain consécutifs', () => {
    expect(parseOperation([{ retain: 2 }, { retain: 3 }])).toEqual([{ retain: 5 }]);
  });

  it('fusionne deux insert consécutifs', () => {
    expect(parseOperation([{ insert: 'a' }, { insert: 'b' }])).toEqual([{ insert: 'ab' }]);
  });

  it('replace un insert après un delete pour le faire précéder', () => {
    expect(parseOperation([{ delete: 2 }, { insert: 'ab' }])).toEqual([{ insert: 'ab' }, { delete: 2 }]);
  });

  it('fusionne plusieurs insert successifs déplacés avant un delete', () => {
    expect(parseOperation([{ delete: 2 }, { insert: 'a' }, { insert: 'b' }])).toEqual([
      { insert: 'ab' },
      { delete: 2 },
    ]);
  });
});

describe('applyOperation', () => {
  it('insère du texte à la position indiquée', () => {
    expect(applyOperation('bonjour', [{ retain: 7 }, { insert: ' monde' }])).toBe('bonjour monde');
  });

  it('supprime du texte à la position indiquée', () => {
    expect(applyOperation('bonjour monde', [{ retain: 7 }, { delete: 6 }])).toBe('bonjour');
  });

  it('combine retain, delete et insert', () => {
    expect(
      applyOperation('bonjour monde', [{ retain: 7 }, { delete: 6 }, { insert: ' univers' }]),
    ).toBe('bonjour univers');
  });

  it('refuse une opération dont la longueur de base ne correspond pas au contenu', () => {
    expect(() => applyOperation('abc', [{ retain: 5 }])).toThrow(InvalidOperationError);
    expect(() => applyOperation('abc', [{ retain: 2 }])).toThrow(InvalidOperationError);
  });
});

function assertConverges(base, operationA, operationB) {
  const [transformedA, transformedB] = transformOperation(operationA, operationB);
  const resultAppliedViaA = applyOperation(applyOperation(base, operationA), transformedB);
  const resultAppliedViaB = applyOperation(applyOperation(base, operationB), transformedA);
  expect(resultAppliedViaA).toBe(resultAppliedViaB);
  return resultAppliedViaA;
}

describe('transformOperation - convergence', () => {
  it('deux insertions à la même position convergent, la priorité (A) apparaissant avant', () => {
    const base = 'abc';
    const operationA = parseOperation([{ retain: 1 }, { insert: 'X' }, { retain: 2 }]);
    const operationB = parseOperation([{ retain: 1 }, { insert: 'Y' }, { retain: 2 }]);

    const convergedText = assertConverges(base, operationA, operationB);

    expect(convergedText).toBe('aXYbc');
  });

  it('deux suppressions qui se chevauchent convergent vers le même texte', () => {
    const base = 'abcdef';
    const operationA = parseOperation([{ retain: 1 }, { delete: 3 }, { retain: 2 }]);
    const operationB = parseOperation([{ retain: 2 }, { delete: 3 }, { retain: 1 }]);

    const convergedText = assertConverges(base, operationA, operationB);

    expect(convergedText).toBe('af');
  });

  it('une insertion dans une zone supprimée par le concurrent survit à la convergence', () => {
    const base = 'abcdef';
    const operationA = parseOperation([{ retain: 1 }, { delete: 4 }, { retain: 1 }]);
    const operationB = parseOperation([{ retain: 3 }, { insert: 'X' }, { retain: 3 }]);

    const convergedText = assertConverges(base, operationA, operationB);

    expect(convergedText).toBe('aXf');
  });
});

function createSeededRandom(seed) {
  let state = seed;
  return function random() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(random, exclusiveMax) {
  return Math.floor(random() * exclusiveMax);
}

const RANDOM_CHARACTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';

function randomString(random, length) {
  let generatedString = '';
  for (let characterIndex = 0; characterIndex < length; characterIndex += 1) {
    generatedString += RANDOM_CHARACTERS[randomInt(random, RANDOM_CHARACTERS.length)];
  }
  return generatedString;
}

function generateRandomOperation(random, baseLength) {
  const rawComponents = [];
  let remainingBaseLength = baseLength;
  while (remainingBaseLength > 0) {
    const actionRoll = random();
    if (actionRoll < 0.2) {
      rawComponents.push({ insert: randomString(random, 1 + randomInt(random, 5)) });
      continue;
    }
    const chunkLength = Math.min(remainingBaseLength, 1 + randomInt(random, 5));
    if (actionRoll < 0.6) {
      rawComponents.push({ retain: chunkLength });
    } else {
      rawComponents.push({ delete: chunkLength });
    }
    remainingBaseLength -= chunkLength;
  }
  if (random() < 0.3) {
    rawComponents.push({ insert: randomString(random, 1 + randomInt(random, 5)) });
  }
  return parseOperation(rawComponents);
}

describe('transformOperation - convergence aléatoire déterministe', () => {
  it('converge sur plusieurs centaines de paires générées avec une graine fixe', () => {
    const random = createSeededRandom(123456789);
    const pairCount = 300;

    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const baseLength = randomInt(random, 30);
      const base = randomString(random, baseLength);
      const operationA = generateRandomOperation(random, baseLength);
      const operationB = generateRandomOperation(random, baseLength);

      assertConverges(base, operationA, operationB);
    }
  });
});

describe('transformIndex', () => {
  it('décale un index situé après une insertion', () => {
    const operation = parseOperation([{ retain: 2 }, { insert: 'XYZ' }, { retain: 4 }]);
    expect(transformIndex(4, operation)).toBe(7);
  });

  it('recule un index situé après une suppression', () => {
    const operation = parseOperation([{ retain: 1 }, { delete: 3 }, { retain: 2 }]);
    expect(transformIndex(5, operation)).toBe(2);
  });

  it('ramène un index situé dans la zone supprimée au début de celle-ci', () => {
    const operation = parseOperation([{ delete: 3 }, { retain: 3 }]);
    expect(transformIndex(1, operation)).toBe(0);
  });
});
