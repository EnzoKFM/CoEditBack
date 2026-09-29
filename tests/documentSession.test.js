import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocumentSession, ResyncRequiredError } from '../src/collaboration/documentSession.js';
import { InvalidOperationError } from '../src/collaboration/textOperation.js';
import { createNode } from '../src/services/nodeService.js';
import { closeDatabase, resetDatabase } from './databaseHelper.js';

const INITIAL_CONTENT = 'abc';

let session;

async function createSession({ maxHistoryLength = 1000, maxHistorySize = 1000000, maxDocumentLength = 1000000 }) {
  const createdFile = await createNode({ parentId: null, type: 'file', name: 'session.txt', content: INITIAL_CONTENT });
  return new DocumentSession({
    fileId: createdFile.id,
    content: INITIAL_CONTENT,
    revision: 0,
    storeDebounceMs: 60000,
    storeMaxDebounceMs: 60000,
    maxHistoryLength,
    maxHistorySize,
    maxDocumentLength,
  });
}

function appendText(documentSession, text) {
  return documentSession.receiveOperation(documentSession.revision, [
    { retain: documentSession.content.length },
    { insert: text },
  ]);
}

beforeEach(resetDatabase);

afterEach(async () => {
  await session?.store();
  session = null;
});

afterAll(closeDatabase);

describe("historique des opérations", () => {
  it('oublie les opérations au-delà de maxHistoryLength et demande une resynchronisation', async () => {
    session = await createSession({ maxHistoryLength: 2 });

    appendText(session, 'd');
    appendText(session, 'e');
    appendText(session, 'f');

    expect(session.operationHistory).toHaveLength(2);
    expect(() => session.receiveOperation(0, [{ insert: 'x' }, { retain: 3 }])).toThrow(ResyncRequiredError);
    expect(session.receiveOperation(1, [{ insert: 'x' }, { retain: 4 }]).revision).toBe(4);
    expect(session.content).toBe('xabcdef');
  });

  it('oublie les opérations les plus anciennes quand leur taille cumulée dépasse maxHistorySize', async () => {
    session = await createSession({ maxHistorySize: 30 });

    appendText(session, 'a'.repeat(10));
    appendText(session, 'b'.repeat(10));
    appendText(session, 'c'.repeat(10));

    expect(session.operationHistory).toHaveLength(2);
    expect(() => session.receiveOperation(0, [{ retain: 3 }, { insert: 'x' }])).toThrow(ResyncRequiredError);
  });
});

describe('taille du document', () => {
  it('refuse une opération qui ferait dépasser maxDocumentLength, sans modifier le document', async () => {
    session = await createSession({ maxDocumentLength: 5 });

    appendText(session, 'de');

    expect(() => appendText(session, 'f')).toThrow(InvalidOperationError);
    expect(() => appendText(session, 'f')).toThrow('Le document ne doit pas dépasser 5 caractères');
    expect(session.content).toBe('abcde');
    expect(session.revision).toBe(1);
  });
});
