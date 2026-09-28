import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { app } from '../src/app.js';
import { createCollaboration } from '../src/collaboration/collaborationServer.js';
import { closeDatabase, resetDatabase } from './databaseHelper.js';

const STORE_DEBOUNCE_MS = 100;
const STORE_MAX_DEBOUNCE_MS = 300;
const WAIT_FOR_TIMEOUT_MS = 3000;
const WAIT_FOR_INTERVAL_MS = 20;
const DOCUMENT_TEXT_NAME = 'content';

let httpServer;
let collaboration;
let collaborationWebSocketUrl;
let connectedProviders = [];

beforeAll(async () => {
  httpServer = app.listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  collaboration = createCollaboration({
    storeDebounceMs: STORE_DEBOUNCE_MS,
    storeMaxDebounceMs: STORE_MAX_DEBOUNCE_MS,
  });
  collaboration.attachToHttpServer(httpServer);
  collaborationWebSocketUrl = `ws://localhost:${httpServer.address().port}/collaboration`;
});

afterAll(async () => {
  collaboration.hocuspocus.closeConnections();
  await new Promise((resolve) => httpServer.close(resolve));
  await closeDatabase();
});

beforeEach(resetDatabase);

afterEach(() => {
  for (const connectedProvider of connectedProviders) {
    connectedProvider.destroy();
  }
  connectedProviders = [];
});

async function createFolder(name, parentId = null) {
  return request(app).post('/api/nodes').send({ type: 'folder', name, parentId });
}

async function createFile(name, parentId = null, content = '') {
  return request(app).post('/api/nodes').send({ type: 'file', name, parentId, content });
}

function connectProvider(fileId, document) {
  const provider = new HocuspocusProvider({
    url: collaborationWebSocketUrl,
    name: String(fileId),
    document,
    WebSocketPolyfill: WebSocket,
    onSynced: () => {},
  });
  connectedProviders.push(provider);
  return provider;
}

async function waitForSynced(provider) {
  await vi.waitFor(
    () => {
      expect(provider.synced).toBe(true);
    },
    { timeout: WAIT_FOR_TIMEOUT_MS, interval: WAIT_FOR_INTERVAL_MS },
  );
}

describe('Connexion à un document de collaboration existant', () => {
  it('reçoit le contenu initial du fichier à la connexion', async () => {
    const initialContent = 'Bonjour le monde';
    const createdFile = (await createFile('accueil.txt', null, initialContent)).body;

    const documentA = new Y.Doc();
    const providerA = connectProvider(createdFile.id, documentA);
    await waitForSynced(providerA);

    expect(documentA.getText(DOCUMENT_TEXT_NAME).toString()).toBe(initialContent);
  });

  it("propage la frappe d'un client vers un second client", async () => {
    const initialContent = 'contenu initial';
    const createdFile = (await createFile('partage.txt', null, initialContent)).body;

    const documentA = new Y.Doc();
    const documentB = new Y.Doc();
    const providerA = connectProvider(createdFile.id, documentA);
    const providerB = connectProvider(createdFile.id, documentB);
    await Promise.all([waitForSynced(providerA), waitForSynced(providerB)]);

    const typedFragment = ' - ajout tapé par Alice';
    documentA.getText(DOCUMENT_TEXT_NAME).insert(initialContent.length, typedFragment);

    await vi.waitFor(
      () => {
        expect(documentB.getText(DOCUMENT_TEXT_NAME).toString()).toBe(initialContent + typedFragment);
      },
      { timeout: WAIT_FOR_TIMEOUT_MS, interval: WAIT_FOR_INTERVAL_MS },
    );
  });

  it('fait converger les textes de deux clients qui insèrent en même temps', async () => {
    const createdFile = (await createFile('concurrent.txt', null, '')).body;

    const documentA = new Y.Doc();
    const documentB = new Y.Doc();
    const providerA = connectProvider(createdFile.id, documentA);
    const providerB = connectProvider(createdFile.id, documentB);
    await Promise.all([waitForSynced(providerA), waitForSynced(providerB)]);

    const insertedByClientA = 'texteDeAlice';
    const insertedByClientB = 'texteDeBob';
    documentA.getText(DOCUMENT_TEXT_NAME).insert(0, insertedByClientA);
    documentB.getText(DOCUMENT_TEXT_NAME).insert(0, insertedByClientB);

    await vi.waitFor(
      () => {
        expect(documentA.getText(DOCUMENT_TEXT_NAME).toString()).toBe(
          documentB.getText(DOCUMENT_TEXT_NAME).toString(),
        );
      },
      { timeout: WAIT_FOR_TIMEOUT_MS, interval: WAIT_FOR_INTERVAL_MS },
    );

    const convergedText = documentA.getText(DOCUMENT_TEXT_NAME).toString();
    expect(convergedText).toContain(insertedByClientA);
    expect(convergedText).toContain(insertedByClientB);
  });

  it("propage les champs d'awareness user et pointer du premier client vers le second", async () => {
    const createdFile = (await createFile('awareness.txt', null, 'contenu')).body;

    const documentA = new Y.Doc();
    const documentB = new Y.Doc();
    const providerA = connectProvider(createdFile.id, documentA);
    const providerB = connectProvider(createdFile.id, documentB);
    await Promise.all([waitForSynced(providerA), waitForSynced(providerB)]);

    providerA.setAwarenessField('user', { name: 'Alice' });
    providerA.setAwarenessField('pointer', { x: 10, y: 20 });

    await vi.waitFor(
      () => {
        const remoteAwarenessStates = Array.from(providerB.awareness.getStates().values());
        const alicesAwarenessState = remoteAwarenessStates.find(
          (awarenessState) => awarenessState.user?.name === 'Alice',
        );
        expect(alicesAwarenessState?.pointer).toEqual({ x: 10, y: 20 });
      },
      { timeout: WAIT_FOR_TIMEOUT_MS, interval: WAIT_FOR_INTERVAL_MS },
    );
  });

  it('sauvegarde le contenu et la size après le délai de debounce, sans déconnexion du client', async () => {
    const initialContent = 'contenu initial';
    const createdFile = (await createFile('journal.txt', null, initialContent)).body;
    const insertedFragment = ' - ajout en direct';
    const expectedContent = initialContent + insertedFragment;

    const documentA = new Y.Doc();
    const providerA = connectProvider(createdFile.id, documentA);
    await waitForSynced(providerA);

    documentA.getText(DOCUMENT_TEXT_NAME).insert(initialContent.length, insertedFragment);

    await vi.waitFor(
      async () => {
        const contentResponse = await request(app).get(`/api/files/${createdFile.id}/content`);
        expect(contentResponse.body.content).toBe(expectedContent);
      },
      { timeout: WAIT_FOR_TIMEOUT_MS, interval: WAIT_FOR_INTERVAL_MS },
    );

    const listingResponse = await request(app).get('/api/folders/root/children');
    const savedFileChild = listingResponse.body.children.find((childNode) => childNode.id === createdFile.id);
    expect(savedFileChild.size).toBe(expectedContent.length);
  });

  it("persiste le texte après déconnexion de tous les clients et le relit sans duplication pour un client qui reconnecte avec son état", async () => {
    const initialContent = 'contenu initial';
    const createdFile = (await createFile('notes.txt', null, initialContent)).body;
    const insertedFragment = ' - session A';
    const expectedContent = initialContent + insertedFragment;

    const documentA = new Y.Doc();
    const providerA = connectProvider(createdFile.id, documentA);
    await waitForSynced(providerA);

    documentA.getText(DOCUMENT_TEXT_NAME).insert(initialContent.length, insertedFragment);

    await vi.waitFor(
      async () => {
        const contentResponse = await request(app).get(`/api/files/${createdFile.id}/content`);
        expect(contentResponse.body.content).toBe(expectedContent);
      },
      { timeout: WAIT_FOR_TIMEOUT_MS, interval: WAIT_FOR_INTERVAL_MS },
    );

    const reconnectingClientState = Y.encodeStateAsUpdate(documentA);

    providerA.destroy();
    connectedProviders = connectedProviders.filter((registeredProvider) => registeredProvider !== providerA);

    await vi.waitFor(
      () => {
        expect(collaboration.hocuspocus.documents.has(String(createdFile.id))).toBe(false);
      },
      { timeout: WAIT_FOR_TIMEOUT_MS, interval: WAIT_FOR_INTERVAL_MS },
    );

    const reconnectingDocument = new Y.Doc();
    Y.applyUpdate(reconnectingDocument, reconnectingClientState);
    const reconnectingProvider = connectProvider(createdFile.id, reconnectingDocument);
    await waitForSynced(reconnectingProvider);

    const reconnectedText = reconnectingDocument.getText(DOCUMENT_TEXT_NAME).toString();
    expect(reconnectedText).toBe(expectedContent);

    const insertedFragmentOccurrences = reconnectedText.split(insertedFragment).length - 1;
    expect(insertedFragmentOccurrences).toBe(1);
  });
});

describe('Connexion rejetée à un document de collaboration invalide', () => {
  it("rejette la connexion à un identifiant de fichier inexistant", async () => {
    let authenticationFailedReason = null;
    let hasSyncedFired = false;
    const provider = new HocuspocusProvider({
      url: collaborationWebSocketUrl,
      name: '999999',
      document: new Y.Doc(),
      WebSocketPolyfill: WebSocket,
      onSynced: () => {
        hasSyncedFired = true;
      },
      onAuthenticationFailed: ({ reason }) => {
        authenticationFailedReason = reason;
      },
    });
    connectedProviders.push(provider);

    await vi.waitFor(
      () => {
        expect(authenticationFailedReason).not.toBeNull();
      },
      { timeout: WAIT_FOR_TIMEOUT_MS, interval: WAIT_FOR_INTERVAL_MS },
    );
    expect(hasSyncedFired).toBe(false);
  });

  it('rejette la connexion à un identifiant désignant un dossier', async () => {
    const createdFolder = (await createFolder('DossierCollaboration')).body;
    let authenticationFailedReason = null;
    let hasSyncedFired = false;
    const provider = new HocuspocusProvider({
      url: collaborationWebSocketUrl,
      name: String(createdFolder.id),
      document: new Y.Doc(),
      WebSocketPolyfill: WebSocket,
      onSynced: () => {
        hasSyncedFired = true;
      },
      onAuthenticationFailed: ({ reason }) => {
        authenticationFailedReason = reason;
      },
    });
    connectedProviders.push(provider);

    await vi.waitFor(
      () => {
        expect(authenticationFailedReason).not.toBeNull();
      },
      { timeout: WAIT_FOR_TIMEOUT_MS, interval: WAIT_FOR_INTERVAL_MS },
    );
    expect(hasSyncedFired).toBe(false);
  });

  it('rejette la connexion à un nom de document non numérique', async () => {
    let authenticationFailedReason = null;
    let hasSyncedFired = false;
    const provider = new HocuspocusProvider({
      url: collaborationWebSocketUrl,
      name: 'abc',
      document: new Y.Doc(),
      WebSocketPolyfill: WebSocket,
      onSynced: () => {
        hasSyncedFired = true;
      },
      onAuthenticationFailed: ({ reason }) => {
        authenticationFailedReason = reason;
      },
    });
    connectedProviders.push(provider);

    await vi.waitFor(
      () => {
        expect(authenticationFailedReason).not.toBeNull();
      },
      { timeout: WAIT_FOR_TIMEOUT_MS, interval: WAIT_FOR_INTERVAL_MS },
    );
    expect(hasSyncedFired).toBe(false);
  });
});
