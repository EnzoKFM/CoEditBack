import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { io as createSocketClient } from 'socket.io-client';
import { app } from '../src/app.js';
import { createCollaboration } from '../src/collaboration/collaborationServer.js';
import { applyOperation, parseOperation, transformOperation } from '../src/collaboration/textOperation.js';
import { createAuthenticatedAgent, deleteTestUser, loginAndGetSessionCookie } from './authHelper.js';
import { closeDatabase, resetDatabase } from './databaseHelper.js';

const STORE_DEBOUNCE_MS = 50;
const STORE_MAX_DEBOUNCE_MS = 200;
const WAIT_FOR_TIMEOUT_MS = 3000;
const WAIT_FOR_INTERVAL_MS = 20;
const COLLABORATION_TEST_EMAIL = 'collaboration@coedit.test';

let httpServer;
let io;
let serverPort;
let connectedSockets = [];
let authenticatedAgent;
let sessionCookie;

beforeAll(async () => {
  httpServer = app.listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  serverPort = httpServer.address().port;
  io = createCollaboration({
    storeDebounceMs: STORE_DEBOUNCE_MS,
    storeMaxDebounceMs: STORE_MAX_DEBOUNCE_MS,
  }).attachToHttpServer(httpServer);
  authenticatedAgent = await createAuthenticatedAgent(COLLABORATION_TEST_EMAIL);
  sessionCookie = await loginAndGetSessionCookie(COLLABORATION_TEST_EMAIL);
});

afterAll(async () => {
  await new Promise((resolve) => io.close(resolve));
  await deleteTestUser(COLLABORATION_TEST_EMAIL);
  await closeDatabase();
});

beforeEach(resetDatabase);

afterEach(() => {
  for (const connectedSocket of connectedSockets) {
    connectedSocket.disconnect();
  }
  connectedSockets = [];
});

async function createFolder(name, parentId = null) {
  return authenticatedAgent.post('/api/nodes').send({ type: 'folder', name, parentId });
}

async function createFile(name, parentId = null, content = '') {
  return authenticatedAgent.post('/api/nodes').send({ type: 'file', name, parentId, content });
}

function connectClient(cookie = sessionCookie) {
  const socket = createSocketClient(`http://localhost:${serverPort}`, {
    transports: ['websocket'],
    extraHeaders: cookie ? { cookie } : {},
  });
  connectedSockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function joinDocument(socket, fileId, user) {
  return socket.emitWithAck('document:join', { fileId, user });
}

function waitForEvent(socket, eventName) {
  return new Promise((resolve) => socket.once(eventName, resolve));
}

function createClientState(joinAcknowledgement) {
  return { content: joinAcknowledgement.content, revision: joinAcknowledgement.revision, pendingOperation: null };
}

function receiveRemoteOperation(clientState, revision, operation) {
  if (clientState.pendingOperation) {
    const [transformedPendingOperation, transformedIncomingOperation] = transformOperation(
      clientState.pendingOperation,
      operation,
    );
    clientState.pendingOperation = transformedPendingOperation;
    clientState.content = applyOperation(clientState.content, transformedIncomingOperation);
  } else {
    clientState.content = applyOperation(clientState.content, operation);
  }
  clientState.revision = revision;
}

function attachOperationListener(socket, clientState) {
  socket.on('document:operation', ({ revision, operation }) => receiveRemoteOperation(clientState, revision, operation));
}

function sendOperationAsClient(socket, clientState, operation) {
  const baseRevision = clientState.revision;
  clientState.content = applyOperation(clientState.content, operation);
  clientState.pendingOperation = operation;
  return new Promise((resolve) => {
    socket.emit('document:operation', { revision: baseRevision, operation }, (acknowledgement) => {
      if (!acknowledgement.error) {
        clientState.pendingOperation = null;
        clientState.revision = acknowledgement.revision;
      }
      resolve(acknowledgement);
    });
  });
}

describe('authentification Socket.IO', () => {
  it('refuse une connexion sans cookie de session', async () => {
    await expect(connectClient(null)).rejects.toThrow('Non authentifié');
  });

  it('refuse une connexion avec un cookie falsifié', async () => {
    await expect(connectClient('token=faux.jeton.jwt')).rejects.toThrow('Non authentifié');
  });

  it('accepte une connexion avec une session valide', async () => {
    const socket = await connectClient();
    expect(socket.connected).toBe(true);
  });
});

describe('document:join', () => {
  it("renvoie le contenu et la révision issus de la création REST", async () => {
    const initialContent = 'Bonjour le monde';
    const createdFile = (await createFile('accueil.txt', null, initialContent)).body;
    const socket = await connectClient();

    const joinAcknowledgement = await joinDocument(socket, createdFile.id, { name: 'Alice', color: '#ff0000' });

    expect(joinAcknowledgement.error).toBeUndefined();
    expect(joinAcknowledgement.content).toBe(initialContent);
    expect(joinAcknowledgement.revision).toBe(0);
    expect(joinAcknowledgement.collaborators).toEqual([]);
    expect(joinAcknowledgement.clientId).toBe(socket.id);
  });

  it('renvoie une erreur pour un fichier inexistant', async () => {
    const socket = await connectClient();

    const joinAcknowledgement = await joinDocument(socket, 999999, { name: 'Alice' });

    expect(joinAcknowledgement.error).toBeDefined();
  });

  it("renvoie une erreur quand l'identifiant désigne un dossier", async () => {
    const createdFolder = (await createFolder('DossierCollaboration')).body;
    const socket = await connectClient();

    const joinAcknowledgement = await joinDocument(socket, createdFolder.id, { name: 'Alice' });

    expect(joinAcknowledgement.error).toBeDefined();
  });

  it('renvoie une erreur pour un identifiant de fichier invalide', async () => {
    const socket = await connectClient();

    const joinAcknowledgement = await joinDocument(socket, 'abc', { name: 'Alice' });

    expect(joinAcknowledgement.error).toBeDefined();
  });
});

describe('document:operation', () => {
  it("propage l'opération d'un client vers un second client", async () => {
    const initialContent = 'contenu initial';
    const createdFile = (await createFile('partage.txt', null, initialContent)).body;
    const socketA = await connectClient();
    const socketB = await connectClient();
    await joinDocument(socketA, createdFile.id, { name: 'Alice' });
    const joinAcknowledgementB = await joinDocument(socketB, createdFile.id, { name: 'Bob' });

    const insertedFragment = ' - ajout tapé par Alice';
    const operation = parseOperation([{ retain: initialContent.length }, { insert: insertedFragment }]);

    const broadcastReceivedByB = waitForEvent(socketB, 'document:operation');
    const operationAcknowledgement = await socketA.emitWithAck('document:operation', {
      revision: joinAcknowledgementB.revision,
      operation,
    });
    const broadcastPayload = await broadcastReceivedByB;

    expect(operationAcknowledgement.error).toBeUndefined();
    expect(operationAcknowledgement.revision).toBe(1);
    expect(broadcastPayload.revision).toBe(1);
    expect(broadcastPayload.operation).toEqual(operation);
    expect(broadcastPayload.clientId).toBe(socketA.id);
  });

  it('fait converger deux opérations concurrentes basées sur la même révision', async () => {
    const initialContent = 'hello world';
    const createdFile = (await createFile('concurrent.txt', null, initialContent)).body;
    const socketA = await connectClient();
    const socketB = await connectClient();
    const joinAcknowledgementA = await joinDocument(socketA, createdFile.id, { name: 'Alice' });
    const joinAcknowledgementB = await joinDocument(socketB, createdFile.id, { name: 'Bob' });

    const clientStateA = createClientState(joinAcknowledgementA);
    const clientStateB = createClientState(joinAcknowledgementB);
    attachOperationListener(socketA, clientStateA);
    attachOperationListener(socketB, clientStateB);

    const operationFromAlice = parseOperation([{ insert: 'Résumé : ' }, { retain: initialContent.length }]);
    const operationFromBob = parseOperation([{ retain: initialContent.length }, { insert: ' - relu par Bob' }]);

    await Promise.all([
      sendOperationAsClient(socketA, clientStateA, operationFromAlice),
      sendOperationAsClient(socketB, clientStateB, operationFromBob),
    ]);

    await vi.waitFor(
      () => {
        expect(clientStateA.revision).toBe(joinAcknowledgementA.revision + 2);
        expect(clientStateB.revision).toBe(joinAcknowledgementB.revision + 2);
      },
      { timeout: WAIT_FOR_TIMEOUT_MS, interval: WAIT_FOR_INTERVAL_MS },
    );

    expect(clientStateA.content).toBe(clientStateB.content);
    expect(clientStateA.content).toContain('Résumé : ');
    expect(clientStateA.content).toContain('relu par Bob');

    await vi.waitFor(
      async () => {
        const contentResponse = await authenticatedAgent.get(`/api/files/${createdFile.id}/content`);
        expect(contentResponse.body.content).toBe(clientStateA.content);
      },
      { timeout: WAIT_FOR_TIMEOUT_MS, interval: WAIT_FOR_INTERVAL_MS },
    );
  });

  it('renvoie une erreur pour une révision de base future', async () => {
    const createdFile = (await createFile('futur.txt', null, 'contenu')).body;
    const socket = await connectClient();
    const joinAcknowledgement = await joinDocument(socket, createdFile.id, { name: 'Alice' });

    const operationAcknowledgement = await socket.emitWithAck('document:operation', {
      revision: joinAcknowledgement.revision + 5,
      operation: parseOperation([{ retain: 7 }]),
    });

    expect(operationAcknowledgement.error).toBeDefined();
    expect(operationAcknowledgement.isResyncRequired).toBe(false);
  });

  it('renvoie une erreur pour une opération invalide', async () => {
    const createdFile = (await createFile('invalide.txt', null, 'contenu')).body;
    const socket = await connectClient();
    const joinAcknowledgement = await joinDocument(socket, createdFile.id, { name: 'Alice' });

    const operationAcknowledgement = await socket.emitWithAck('document:operation', {
      revision: joinAcknowledgement.revision,
      operation: 'pas-un-tableau',
    });

    expect(operationAcknowledgement.error).toBeDefined();
    expect(operationAcknowledgement.isResyncRequired).toBe(false);
  });
});

describe('présence', () => {
  it('relaie une mise à jour de présence aux autres clients du même document', async () => {
    const createdFile = (await createFile('presence.txt', null, 'contenu partagé')).body;
    const socketA = await connectClient();
    const socketB = await connectClient();
    await joinDocument(socketA, createdFile.id, { name: 'Alice', color: '#123456' });
    await joinDocument(socketB, createdFile.id, { name: 'Bob' });

    const presenceReceivedByB = waitForEvent(socketB, 'presence:update');
    socketA.emit('presence:update', { selection: { anchor: 3, head: 3 }, pointer: { x: 10, y: 20 } });
    const presencePayload = await presenceReceivedByB;

    expect(presencePayload.clientId).toBe(socketA.id);
    expect(presencePayload.user.name).toBe('Alice');
    expect(presencePayload.selection).toEqual({ anchor: 3, head: 3 });
    expect(presencePayload.pointer).toEqual({ x: 10, y: 20 });
  });

  it("renvoie dans collaborators la présence d'un client déjà connecté, avec sa sélection transformée après une insertion avant elle", async () => {
    const initialContent = 'lorem ipsum dolor';
    const createdFile = (await createFile('selection.txt', null, initialContent)).body;
    const socketA = await connectClient();
    const joinAcknowledgementA = await joinDocument(socketA, createdFile.id, { name: 'Alice', color: '#abcdef' });

    socketA.emit('presence:update', { selection: { anchor: 10, head: 10 }, pointer: { x: 3, y: 4 } });
    const insertedFragment = 'XYZ';
    const operation = parseOperation([{ insert: insertedFragment }, { retain: initialContent.length }]);
    const operationAcknowledgement = await socketA.emitWithAck('document:operation', {
      revision: joinAcknowledgementA.revision,
      operation,
    });
    expect(operationAcknowledgement.error).toBeUndefined();

    const socketB = await connectClient();
    const joinAcknowledgementB = await joinDocument(socketB, createdFile.id, { name: 'Bob' });

    expect(joinAcknowledgementB.collaborators).toHaveLength(1);
    const alicesCollaborator = joinAcknowledgementB.collaborators[0];
    expect(alicesCollaborator.clientId).toBe(socketA.id);
    expect(alicesCollaborator.user.name).toBe('Alice');
    expect(alicesCollaborator.selection).toEqual({
      anchor: 10 + insertedFragment.length,
      head: 10 + insertedFragment.length,
    });
  });

  it('diffuse presence:leave aux autres clients à la déconnexion', async () => {
    const createdFile = (await createFile('depart.txt', null, 'contenu')).body;
    const socketA = await connectClient();
    const socketB = await connectClient();
    await joinDocument(socketA, createdFile.id, { name: 'Alice' });
    await joinDocument(socketB, createdFile.id, { name: 'Bob' });

    const disconnectingClientId = socketB.id;
    const leaveReceivedByA = waitForEvent(socketA, 'presence:leave');
    socketB.disconnect();
    const leavePayload = await leaveReceivedByA;

    expect(leavePayload.clientId).toBe(disconnectingClientId);
  });
});

describe('sauvegarde', () => {
  it('sauvegarde récurrente le contenu après le délai de debounce, la size du listage étant à jour', async () => {
    const initialContent = 'contenu initial';
    const createdFile = (await createFile('journal.txt', null, initialContent)).body;
    const insertedFragment = ' - ajout en direct';
    const expectedContent = initialContent + insertedFragment;
    const socket = await connectClient();
    const joinAcknowledgement = await joinDocument(socket, createdFile.id, { name: 'Alice' });

    await socket.emitWithAck('document:operation', {
      revision: joinAcknowledgement.revision,
      operation: parseOperation([{ retain: initialContent.length }, { insert: insertedFragment }]),
    });

    await vi.waitFor(
      async () => {
        const contentResponse = await authenticatedAgent.get(`/api/files/${createdFile.id}/content`);
        expect(contentResponse.body.content).toBe(expectedContent);
      },
      { timeout: WAIT_FOR_TIMEOUT_MS, interval: WAIT_FOR_INTERVAL_MS },
    );

    const listingResponse = await authenticatedAgent.get('/api/folders/root/children');
    const savedFileChild = listingResponse.body.children.find((childNode) => childNode.id === createdFile.id);
    expect(savedFileChild.size).toBe(expectedContent.length);
  });

  it('sauvegarde au départ du dernier client puis recharge la session sans doublon et avec la révision conservée', async () => {
    const initialContent = 'contenu initial';
    const createdFile = (await createFile('notes.txt', null, initialContent)).body;
    const insertedFragment = ' - session A';
    const expectedContent = initialContent + insertedFragment;
    const socketA = await connectClient();
    const joinAcknowledgementA = await joinDocument(socketA, createdFile.id, { name: 'Alice' });

    const operationAcknowledgement = await socketA.emitWithAck('document:operation', {
      revision: joinAcknowledgementA.revision,
      operation: parseOperation([{ retain: initialContent.length }, { insert: insertedFragment }]),
    });

    socketA.disconnect();

    await vi.waitFor(
      async () => {
        const contentResponse = await authenticatedAgent.get(`/api/files/${createdFile.id}/content`);
        expect(contentResponse.body.content).toBe(expectedContent);
      },
      { timeout: WAIT_FOR_TIMEOUT_MS, interval: WAIT_FOR_INTERVAL_MS },
    );

    const socketReconnecting = await connectClient();
    const joinAcknowledgementReconnecting = await joinDocument(socketReconnecting, createdFile.id, { name: 'Alice' });

    expect(joinAcknowledgementReconnecting.content).toBe(expectedContent);
    expect(joinAcknowledgementReconnecting.revision).toBe(operationAcknowledgement.revision);
    const insertedFragmentOccurrences = joinAcknowledgementReconnecting.content.split(insertedFragment).length - 1;
    expect(insertedFragmentOccurrences).toBe(1);
  });
});
