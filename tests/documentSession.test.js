import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DocumentSession,
  MAX_CHAT_HISTORY_LENGTH,
  MAX_CHAT_MESSAGE_LENGTH,
  ResyncRequiredError,
} from '../src/collaboration/documentSession.js';
import { InvalidOperationError } from '../src/collaboration/textOperation.js';
import { createNode } from '../src/services/nodeService.js';
import { createTestUser, deleteTestUser } from './authHelper.js';
import { closeDatabase, resetDatabase } from './databaseHelper.js';

const INITIAL_CONTENT = 'abc';
const SESSION_OWNER_EMAIL = 'document-session@coedit.test';

let session;
let sessionOwner;

async function createSession({ maxHistoryLength = 1000, maxHistorySize = 1000000, maxDocumentLength = 1000000 }) {
  const createdFile = await createNode({
    parentId: null,
    type: 'file',
    name: 'session.txt',
    content: INITIAL_CONTENT,
    user: sessionOwner,
  });
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

beforeAll(async () => {
  sessionOwner = { id: await createTestUser(SESSION_OWNER_EMAIL), role: 'user' };
});
beforeEach(resetDatabase);

afterEach(async () => {
  await session?.store();
  session = null;
});

afterAll(async () => {
  await deleteTestUser(SESSION_OWNER_EMAIL);
  await closeDatabase();
});

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

describe('messagerie de la session', () => {
  const author = { userId: 7, name: 'Alice Martin' };

  it("enregistre le message avec l'auteur, un identifiant et la date d'envoi", async () => {
    session = await createSession({});

    const chatMessage = session.addChatMessage(author, '  Bonjour  ');

    expect(chatMessage).toMatchObject({ author, text: 'Bonjour' });
    expect(chatMessage.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(chatMessage.sentAt))).toBe(false);
    expect(session.listChatMessages()).toEqual([chatMessage]);
  });

  it.each([undefined, null, 42, '', '   '])('refuse un message vide ou non textuel (%s)', async (rawText) => {
    session = await createSession({});

    expect(() => session.addChatMessage(author, rawText)).toThrow('Le message est vide');
    expect(session.listChatMessages()).toEqual([]);
  });

  it('refuse un message trop long', async () => {
    session = await createSession({});

    expect(() => session.addChatMessage(author, 'a'.repeat(MAX_CHAT_MESSAGE_LENGTH + 1))).toThrow(
      `Le message ne doit pas dépasser ${MAX_CHAT_MESSAGE_LENGTH} caractères`,
    );
    expect(session.addChatMessage(author, 'a'.repeat(MAX_CHAT_MESSAGE_LENGTH)).text).toHaveLength(
      MAX_CHAT_MESSAGE_LENGTH,
    );
  });

  it('ne garde que les derniers messages', async () => {
    session = await createSession({});

    for (let messageNumber = 1; messageNumber <= MAX_CHAT_HISTORY_LENGTH + 5; messageNumber += 1) {
      session.addChatMessage(author, `message ${messageNumber}`);
    }

    const chatMessages = session.listChatMessages();
    expect(chatMessages).toHaveLength(MAX_CHAT_HISTORY_LENGTH);
    expect(chatMessages[0].text).toBe('message 6');
    expect(chatMessages.at(-1).text).toBe(`message ${MAX_CHAT_HISTORY_LENGTH + 5}`);
  });
});
