import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { io as createSocketClient } from 'socket.io-client';
import { app } from '../src/app.js';
import { createCollaboration } from '../src/collaboration/collaborationServer.js';
import { applyOperation, parseOperation, transformOperation } from '../src/collaboration/textOperation.js';
import { createAuthenticatedAgent, createTestUser, deleteTestUser, loginAndGetSessionCookie } from './authHelper.js';
import { closeDatabase, resetDatabase } from './databaseHelper.js';

const STORE_DEBOUNCE_MS = 50;
const STORE_MAX_DEBOUNCE_MS = 200;
const WAIT_FOR_TIMEOUT_MS = 3000;
const WAIT_FOR_INTERVAL_MS = 20;
const COLLABORATION_TEST_EMAIL = 'collaboration@coedit.test';
const GUEST_TEST_EMAIL = 'collaboration-invite@coedit.test';
const ADMIN_TEST_EMAIL = 'collaboration-admin@coedit.test';
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let httpServer;
let io;
let serverPort;
let connectedSockets = [];
let authenticatedAgent;
let sessionCookie;
let guestSessionCookie;
let adminSessionCookie;

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
  await createAuthenticatedAgent(GUEST_TEST_EMAIL);
  guestSessionCookie = await loginAndGetSessionCookie(GUEST_TEST_EMAIL);
  await createAuthenticatedAgent(ADMIN_TEST_EMAIL, 'admin');
  adminSessionCookie = await loginAndGetSessionCookie(ADMIN_TEST_EMAIL);
});

afterAll(async () => {
  await new Promise((resolve) => io.close(resolve));
  await deleteTestUser(COLLABORATION_TEST_EMAIL);
  await deleteTestUser(GUEST_TEST_EMAIL);
  await deleteTestUser(ADMIN_TEST_EMAIL);
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

async function startDedicatedCollaboration(collaborationOptions) {
  const dedicatedHttpServer = app.listen(0);
  await new Promise((resolve) => dedicatedHttpServer.once('listening', resolve));
  const collaboration = createCollaboration(collaborationOptions);
  const socketServer = collaboration.attachToHttpServer(dedicatedHttpServer);
  return { collaboration, socketServer, port: dedicatedHttpServer.address().port };
}

function connectClient(cookie = sessionCookie, port = serverPort) {
  const socket = createSocketClient(`http://localhost:${port}`, {
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

  it("renvoie une erreur quand l'identifiant désigne un fichier binaire", async () => {
    const uploadResponse = await authenticatedAgent
      .post('/api/files')
      .attach('file', PNG_BYTES, { filename: 'image.png', contentType: 'image/png' });
    const socket = await connectClient();

    const joinAcknowledgement = await joinDocument(socket, uploadResponse.body.id, { name: 'Alice' });

    expect(uploadResponse.status).toBe(201);
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

  it("enregistre l'auteur de la dernière édition en direct comme dernier modificateur", async () => {
    const editorEmail = 'editeur-collaboration@coedit.test';
    const editorId = await createTestUser(editorEmail, 'admin');
    try {
      const createdFile = (await createFile('auteur-edition.txt', null, 'abc')).body;
      const editorSocket = await connectClient(await loginAndGetSessionCookie(editorEmail));
      const joinAcknowledgement = await joinDocument(editorSocket, createdFile.id, { name: 'Éditeur' });

      await editorSocket.emitWithAck('document:operation', {
        revision: joinAcknowledgement.revision,
        operation: parseOperation([{ retain: 3 }, { insert: 'd' }]),
      });

      await vi.waitFor(
        async () => {
          const nodeResponse = await authenticatedAgent.get(`/api/nodes/${createdFile.id}`);
          expect(nodeResponse.body.updatedBy).toEqual({ id: editorId, name: 'Test Utilisateur' });
        },
        { timeout: WAIT_FOR_TIMEOUT_MS, interval: WAIT_FOR_INTERVAL_MS },
      );
      const nodeResponse = await authenticatedAgent.get(`/api/nodes/${createdFile.id}`);
      expect(nodeResponse.body.createdBy.id).not.toBe(editorId);
    } finally {
      await deleteTestUser(editorEmail);
    }
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

describe('appel audio', () => {
  async function createConnectedClient(fileId, user) {
    const socket = await connectClient();
    const joinAcknowledgement = await joinDocument(socket, fileId, user);
    return { socket, clientId: joinAcknowledgement.clientId };
  }

  function inviteCall(socket, targetClientId) {
    return socket.emitWithAck('call:invite', { targetClientId });
  }

  function acceptCall(socket, callId) {
    return socket.emitWithAck('call:accept', { callId });
  }

  it("mène un appel complet de l'invitation au raccroché avec relais des signaux WebRTC", async () => {
    const createdFile = (await createFile('appel-complet.txt', null, 'contenu')).body;
    const caller = await createConnectedClient(createdFile.id, { name: 'Alice' });
    const callee = await createConnectedClient(createdFile.id, { name: 'Bob' });

    const incomingCallReceivedByCallee = waitForEvent(callee.socket, 'call:incoming');
    const inviteAcknowledgement = await inviteCall(caller.socket, callee.clientId);
    const incomingCallPayload = await incomingCallReceivedByCallee;

    expect(inviteAcknowledgement.error).toBeUndefined();
    expect(inviteAcknowledgement.callId).toBeDefined();
    expect(incomingCallPayload).toEqual({
      callId: inviteAcknowledgement.callId,
      caller: { clientId: caller.clientId, user: { name: 'Alice', color: null } },
    });

    const acceptedReceivedByCaller = waitForEvent(caller.socket, 'call:accepted');
    const acceptAcknowledgement = await acceptCall(callee.socket, incomingCallPayload.callId);
    const acceptedPayload = await acceptedReceivedByCaller;

    expect(acceptAcknowledgement.callId).toBe(incomingCallPayload.callId);
    expect(acceptedPayload).toEqual({ callId: incomingCallPayload.callId, clientId: callee.clientId });

    const offerReceivedByCallee = waitForEvent(callee.socket, 'call:signal');
    caller.socket.emit('call:signal', {
      targetClientId: callee.clientId,
      description: { type: 'offer', sdp: 'offre-sdp' },
    });
    expect(await offerReceivedByCallee).toEqual({
      clientId: caller.clientId,
      description: { type: 'offer', sdp: 'offre-sdp' },
    });

    const answerReceivedByCaller = waitForEvent(caller.socket, 'call:signal');
    callee.socket.emit('call:signal', {
      targetClientId: caller.clientId,
      description: { type: 'answer', sdp: 'reponse-sdp' },
    });
    expect(await answerReceivedByCaller).toEqual({
      clientId: callee.clientId,
      description: { type: 'answer', sdp: 'reponse-sdp' },
    });

    const candidateReceivedByCallee = waitForEvent(callee.socket, 'call:signal');
    caller.socket.emit('call:signal', { targetClientId: callee.clientId, candidate: { candidate: 'candidat-ice' } });
    expect(await candidateReceivedByCallee).toEqual({
      clientId: caller.clientId,
      candidate: { candidate: 'candidat-ice', sdpMid: null, sdpMLineIndex: null, usernameFragment: null },
    });

    const callEndedReceivedByCallee = waitForEvent(callee.socket, 'call:ended');
    caller.socket.emit('call:hangup');
    expect(await callEndedReceivedByCallee).toEqual({ callId: incomingCallPayload.callId, reason: 'hangup' });
  });

  it("l'appelé peut refuser un appel avant de l'accepter", async () => {
    const createdFile = (await createFile('appel-refuse.txt', null, 'contenu')).body;
    const caller = await createConnectedClient(createdFile.id, { name: 'Alice' });
    const callee = await createConnectedClient(createdFile.id, { name: 'Bob' });

    const incomingCallReceivedByCallee = waitForEvent(callee.socket, 'call:incoming');
    const inviteAcknowledgement = await inviteCall(caller.socket, callee.clientId);
    await incomingCallReceivedByCallee;

    const callEndedReceivedByCaller = waitForEvent(caller.socket, 'call:ended');
    callee.socket.emit('call:hangup');
    expect(await callEndedReceivedByCaller).toEqual({ callId: inviteAcknowledgement.callId, reason: 'declined' });
  });

  it("call:invite renvoie une erreur quand l'appelant n'a rejoint aucun document", async () => {
    const socket = await connectClient();

    const inviteAcknowledgement = await inviteCall(socket, 'un-identifiant-quelconque');

    expect(inviteAcknowledgement.error).toBe('Aucun document rejoint');
  });

  it("call:invite renvoie une erreur quand la cible n'est pas dans le même document", async () => {
    const createdFileA = (await createFile('doc-a.txt', null, 'contenu')).body;
    const createdFileB = (await createFile('doc-b.txt', null, 'contenu')).body;
    const caller = await createConnectedClient(createdFileA.id, { name: 'Alice' });
    const outsider = await createConnectedClient(createdFileB.id, { name: 'Bob' });

    const inviteAcknowledgement = await inviteCall(caller.socket, outsider.clientId);

    expect(inviteAcknowledgement.error).toBe('Correspondant absent du document');
  });

  it("call:invite renvoie une erreur quand on tente de s'appeler soi-même", async () => {
    const createdFile = (await createFile('appel-soi-meme.txt', null, 'contenu')).body;
    const caller = await createConnectedClient(createdFile.id, { name: 'Alice' });

    const inviteAcknowledgement = await inviteCall(caller.socket, caller.clientId);

    expect(inviteAcknowledgement.error).toBe("Impossible de s'appeler soi-même");
  });

  it("call:invite renvoie une erreur quand l'appelant a un appel en attente de réponse", async () => {
    const createdFile = (await createFile('appelant-occupe.txt', null, 'contenu')).body;
    const caller = await createConnectedClient(createdFile.id, { name: 'Alice' });
    const ringingCallee = await createConnectedClient(createdFile.id, { name: 'Bob' });
    const thirdPerson = await createConnectedClient(createdFile.id, { name: 'Carla' });
    await inviteCall(caller.socket, ringingCallee.clientId);

    const inviteAcknowledgement = await inviteCall(ringingCallee.socket, thirdPerson.clientId);

    expect(inviteAcknowledgement.error).toBe('Vous êtes déjà en appel');
  });

  it("call:invite renvoie une erreur quand la cible est déjà en appel, y compris en sonnerie", async () => {
    const createdFile = (await createFile('cible-occupee.txt', null, 'contenu')).body;
    const firstCaller = await createConnectedClient(createdFile.id, { name: 'Alice' });
    const busyCallee = await createConnectedClient(createdFile.id, { name: 'Bob' });
    const secondCaller = await createConnectedClient(createdFile.id, { name: 'Carla' });
    await inviteCall(firstCaller.socket, busyCallee.clientId);

    const inviteAcknowledgement = await inviteCall(secondCaller.socket, busyCallee.clientId);

    expect(inviteAcknowledgement.error).toBe('Correspondant déjà en appel');
  });

  it("call:accept renvoie une erreur pour un identifiant d'appel inconnu", async () => {
    const socket = await connectClient();

    const acceptAcknowledgement = await acceptCall(socket, 'identifiant-inexistant');

    expect(acceptAcknowledgement.error).toBe('Appel introuvable');
  });

  it("call:accept renvoie une erreur quand le client n'est pas l'appelé", async () => {
    const createdFile = (await createFile('accept-mauvais-client.txt', null, 'contenu')).body;
    const caller = await createConnectedClient(createdFile.id, { name: 'Alice' });
    const callee = await createConnectedClient(createdFile.id, { name: 'Bob' });
    const bystander = await createConnectedClient(createdFile.id, { name: 'Carla' });
    const inviteAcknowledgement = await inviteCall(caller.socket, callee.clientId);

    const acceptAcknowledgement = await acceptCall(bystander.socket, inviteAcknowledgement.callId);

    expect(acceptAcknowledgement.error).toBe('Appel introuvable');
  });

  it("call:accept renvoie une erreur quand l'appel est déjà accepté", async () => {
    const createdFile = (await createFile('accept-double.txt', null, 'contenu')).body;
    const caller = await createConnectedClient(createdFile.id, { name: 'Alice' });
    const callee = await createConnectedClient(createdFile.id, { name: 'Bob' });
    const inviteAcknowledgement = await inviteCall(caller.socket, callee.clientId);
    await acceptCall(callee.socket, inviteAcknowledgement.callId);

    const secondAcceptAcknowledgement = await acceptCall(callee.socket, inviteAcknowledgement.callId);

    expect(secondAcceptAcknowledgement.error).toBe('Appel introuvable');
  });

  it('ignore un signal invalide sans perturber le relais du signal valide suivant', async () => {
    const createdFile = (await createFile('signal-invalide.txt', null, 'contenu')).body;
    const caller = await createConnectedClient(createdFile.id, { name: 'Alice' });
    const callee = await createConnectedClient(createdFile.id, { name: 'Bob' });
    const inviteAcknowledgement = await inviteCall(caller.socket, callee.clientId);
    await acceptCall(callee.socket, inviteAcknowledgement.callId);

    const signalReceivedByCallee = waitForEvent(callee.socket, 'call:signal');
    caller.socket.emit('call:signal', {
      targetClientId: callee.clientId,
      description: { type: 'invalide', sdp: 'sdp-ignore' },
    });
    caller.socket.emit('call:signal', {
      targetClientId: callee.clientId,
      description: { type: 'offer', sdp: 'offre-valide' },
    });

    expect(await signalReceivedByCallee).toEqual({
      clientId: caller.clientId,
      description: { type: 'offer', sdp: 'offre-valide' },
    });
  });

  it("raccroche automatiquement l'appel accepté à la déconnexion d'un client", async () => {
    const createdFile = (await createFile('raccroche-deconnexion.txt', null, 'contenu')).body;
    const caller = await createConnectedClient(createdFile.id, { name: 'Alice' });
    const callee = await createConnectedClient(createdFile.id, { name: 'Bob' });
    const inviteAcknowledgement = await inviteCall(caller.socket, callee.clientId);
    await acceptCall(callee.socket, inviteAcknowledgement.callId);

    const callEndedReceivedByCaller = waitForEvent(caller.socket, 'call:ended');
    callee.socket.disconnect();

    expect(await callEndedReceivedByCaller).toEqual({ callId: inviteAcknowledgement.callId, reason: 'hangup' });
  });

  it("raccroche automatiquement l'appel accepté quand un client quitte le document", async () => {
    const createdFile = (await createFile('raccroche-depart.txt', null, 'contenu')).body;
    const caller = await createConnectedClient(createdFile.id, { name: 'Alice' });
    const callee = await createConnectedClient(createdFile.id, { name: 'Bob' });
    const inviteAcknowledgement = await inviteCall(caller.socket, callee.clientId);
    await acceptCall(callee.socket, inviteAcknowledgement.callId);

    const callEndedReceivedByCallee = waitForEvent(callee.socket, 'call:ended');
    caller.socket.emit('document:leave');

    expect(await callEndedReceivedByCallee).toEqual({ callId: inviteAcknowledgement.callId, reason: 'hangup' });
  });

  it("les deux clients peuvent se rappeler après la fin d'un appel", async () => {
    const createdFile = (await createFile('rappel.txt', null, 'contenu')).body;
    const caller = await createConnectedClient(createdFile.id, { name: 'Alice' });
    const callee = await createConnectedClient(createdFile.id, { name: 'Bob' });
    const firstInviteAcknowledgement = await inviteCall(caller.socket, callee.clientId);
    await acceptCall(callee.socket, firstInviteAcknowledgement.callId);
    const callEndedReceivedByCallee = waitForEvent(callee.socket, 'call:ended');
    caller.socket.emit('call:hangup');
    await callEndedReceivedByCallee;

    const incomingSecondCallReceivedByCaller = waitForEvent(caller.socket, 'call:incoming');
    const secondInviteAcknowledgement = await inviteCall(callee.socket, caller.clientId);
    const incomingSecondCallPayload = await incomingSecondCallReceivedByCaller;

    expect(secondInviteAcknowledgement.error).toBeUndefined();
    expect(incomingSecondCallPayload.callId).toBe(secondInviteAcknowledgement.callId);
  });

  it("relaie l'état du micro uniquement à l'interlocuteur d'un appel accepté", async () => {
    const createdFile = (await createFile('micro.txt', null, 'contenu')).body;
    const caller = await createConnectedClient(createdFile.id, { name: 'Alice' });
    const callee = await createConnectedClient(createdFile.id, { name: 'Bob' });
    const bystander = await createConnectedClient(createdFile.id, { name: 'Carol' });
    const muteReceivedByBystander = vi.fn();
    bystander.socket.on('call:mute', muteReceivedByBystander);
    const inviteAcknowledgement = await inviteCall(caller.socket, callee.clientId);
    await acceptCall(callee.socket, inviteAcknowledgement.callId);

    const mutedReceivedByCallee = waitForEvent(callee.socket, 'call:mute');
    caller.socket.emit('call:mute', { muted: true });
    expect(await mutedReceivedByCallee).toEqual({ clientId: caller.clientId, muted: true });

    const unmutedReceivedByCaller = waitForEvent(caller.socket, 'call:mute');
    callee.socket.emit('call:mute', { muted: false });
    expect(await unmutedReceivedByCaller).toEqual({ clientId: callee.clientId, muted: false });

    await bystander.socket.emitWithAck('chat:history');
    expect(muteReceivedByBystander).not.toHaveBeenCalled();
  });

  it("ignore l'état du micro avant l'acceptation de l'appel ou s'il est invalide", async () => {
    const createdFile = (await createFile('micro-refus.txt', null, 'contenu')).body;
    const caller = await createConnectedClient(createdFile.id, { name: 'Alice' });
    const callee = await createConnectedClient(createdFile.id, { name: 'Bob' });
    const muteReceivedByCallee = vi.fn();
    callee.socket.on('call:mute', muteReceivedByCallee);

    caller.socket.emit('call:mute', { muted: true });
    const inviteAcknowledgement = await inviteCall(caller.socket, callee.clientId);
    caller.socket.emit('call:mute', { muted: true });
    await acceptCall(callee.socket, inviteAcknowledgement.callId);
    caller.socket.emit('call:mute', { muted: 'oui' });
    caller.socket.emit('call:mute');
    await callee.socket.emitWithAck('chat:history');
    await caller.socket.emitWithAck('chat:history');
    await callee.socket.emitWithAck('chat:history');

    expect(muteReceivedByCallee).not.toHaveBeenCalled();
  });

  async function addToCall(inviter, invitee) {
    const inviteAcknowledgement = await inviteCall(inviter.socket, invitee.clientId);
    await acceptCall(invitee.socket, inviteAcknowledgement.callId);
    return inviteAcknowledgement.callId;
  }

  async function startGroupCall(fileName) {
    const createdFile = (await createFile(fileName, null, 'contenu')).body;
    const alice = await createConnectedClient(createdFile.id, { name: 'Alice' });
    const bob = await createConnectedClient(createdFile.id, { name: 'Bob' });
    const carla = await createConnectedClient(createdFile.id, { name: 'Carla' });
    const callId = await addToCall(alice, bob);
    await addToCall(bob, carla);
    return { createdFile, alice, bob, carla, callId };
  }

  it("un participant invite une troisième personne qui reçoit la liste des participants à joindre", async () => {
    const createdFile = (await createFile('appel-groupe.txt', null, 'contenu')).body;
    const alice = await createConnectedClient(createdFile.id, { name: 'Alice' });
    const bob = await createConnectedClient(createdFile.id, { name: 'Bob' });
    const carla = await createConnectedClient(createdFile.id, { name: 'Carla' });
    const callId = await addToCall(alice, bob);

    const incomingCallReceivedByCarla = waitForEvent(carla.socket, 'call:incoming');
    const inviteAcknowledgement = await inviteCall(bob.socket, carla.clientId);
    expect(inviteAcknowledgement).toEqual({ callId });
    expect(await incomingCallReceivedByCarla).toEqual({
      callId,
      caller: { clientId: bob.clientId, user: { name: 'Bob', color: null } },
    });

    const acceptedReceivedByAlice = waitForEvent(alice.socket, 'call:accepted');
    const acceptedReceivedByBob = waitForEvent(bob.socket, 'call:accepted');
    const acceptAcknowledgement = await acceptCall(carla.socket, callId);

    expect(await acceptedReceivedByAlice).toEqual({ callId, clientId: carla.clientId });
    expect(await acceptedReceivedByBob).toEqual({ callId, clientId: carla.clientId });
    expect(acceptAcknowledgement.participants).toHaveLength(2);
    expect(acceptAcknowledgement.participants).toEqual(
      expect.arrayContaining([
        { clientId: alice.clientId, user: { name: 'Alice', color: null } },
        { clientId: bob.clientId, user: { name: 'Bob', color: null } },
      ]),
    );

    const offerReceivedByAlice = waitForEvent(alice.socket, 'call:signal');
    carla.socket.emit('call:signal', { targetClientId: alice.clientId, description: { type: 'offer', sdp: 'offre-a' } });
    expect(await offerReceivedByAlice).toEqual({
      clientId: carla.clientId,
      description: { type: 'offer', sdp: 'offre-a' },
    });
  });

  it("un participant qui raccroche quitte l'appel sans l'arrêter pour les autres", async () => {
    const { alice, bob, carla, callId } = await startGroupCall('appel-groupe-depart.txt');

    const leftReceivedByAlice = waitForEvent(alice.socket, 'call:left');
    const leftReceivedByCarla = waitForEvent(carla.socket, 'call:left');
    bob.socket.emit('call:hangup');

    expect(await leftReceivedByAlice).toEqual({ callId, clientId: bob.clientId, reason: 'hangup' });
    expect(await leftReceivedByCarla).toEqual({ callId, clientId: bob.clientId, reason: 'hangup' });

    const signalReceivedByAlice = vi.fn();
    alice.socket.on('call:signal', signalReceivedByAlice);
    bob.socket.emit('call:signal', { targetClientId: alice.clientId, description: { type: 'offer', sdp: 'ignoree' } });
    await bob.socket.emitWithAck('chat:history');
    const offerReceivedByAlice = waitForEvent(alice.socket, 'call:signal');
    carla.socket.emit('call:signal', { targetClientId: alice.clientId, description: { type: 'offer', sdp: 'offre-c' } });
    expect(await offerReceivedByAlice).toEqual({ clientId: carla.clientId, description: { type: 'offer', sdp: 'offre-c' } });
    expect(signalReceivedByAlice).toHaveBeenCalledTimes(1);

    const callEndedReceivedByAlice = waitForEvent(alice.socket, 'call:ended');
    carla.socket.emit('call:hangup');
    expect(await callEndedReceivedByAlice).toEqual({ callId, reason: 'hangup' });
  });

  it("un refus pendant un appel en cours prévient les participants sans arrêter l'appel", async () => {
    const createdFile = (await createFile('appel-groupe-refus.txt', null, 'contenu')).body;
    const alice = await createConnectedClient(createdFile.id, { name: 'Alice' });
    const bob = await createConnectedClient(createdFile.id, { name: 'Bob' });
    const carla = await createConnectedClient(createdFile.id, { name: 'Carla' });
    const callId = await addToCall(alice, bob);
    await inviteCall(alice.socket, carla.clientId);

    const leftReceivedByAlice = waitForEvent(alice.socket, 'call:left');
    const leftReceivedByBob = waitForEvent(bob.socket, 'call:left');
    carla.socket.emit('call:hangup');

    expect(await leftReceivedByAlice).toEqual({ callId, clientId: carla.clientId, reason: 'declined' });
    expect(await leftReceivedByBob).toEqual({ callId, clientId: carla.clientId, reason: 'declined' });
  });

  it("relaie l'état du micro à tous les autres participants de l'appel", async () => {
    const { alice, bob, carla } = await startGroupCall('appel-groupe-micro.txt');

    const muteReceivedByBob = waitForEvent(bob.socket, 'call:mute');
    const muteReceivedByCarla = waitForEvent(carla.socket, 'call:mute');
    alice.socket.emit('call:mute', { muted: true });

    expect(await muteReceivedByBob).toEqual({ clientId: alice.clientId, muted: true });
    expect(await muteReceivedByCarla).toEqual({ clientId: alice.clientId, muted: true });
  });

  it("relaie l'état de la caméra à tous les autres participants de l'appel", async () => {
    const { alice, bob, carla } = await startGroupCall('appel-groupe-camera.txt');

    const cameraReceivedByBob = waitForEvent(bob.socket, 'call:camera');
    const cameraReceivedByCarla = waitForEvent(carla.socket, 'call:camera');
    const cameraAcknowledgement = await alice.socket.emitWithAck('call:camera', { enabled: true });

    expect(cameraAcknowledgement).toEqual({ enabled: true });
    expect(await cameraReceivedByBob).toEqual({ clientId: alice.clientId, enabled: true });
    expect(await cameraReceivedByCarla).toEqual({ clientId: alice.clientId, enabled: true });
  });

  it("refuse l'état de la caméra hors d'un appel accepté ou s'il est invalide", async () => {
    const createdFile = (await createFile('camera-refus.txt', null, 'contenu')).body;
    const caller = await createConnectedClient(createdFile.id, { name: 'Alice' });
    const callee = await createConnectedClient(createdFile.id, { name: 'Bob' });
    const cameraReceivedByCallee = vi.fn();
    callee.socket.on('call:camera', cameraReceivedByCallee);

    const acknowledgementWithoutCall = await caller.socket.emitWithAck('call:camera', { enabled: true });
    const inviteAcknowledgement = await inviteCall(caller.socket, callee.clientId);
    const acknowledgementFromInvitee = await callee.socket.emitWithAck('call:camera', { enabled: true });
    await acceptCall(callee.socket, inviteAcknowledgement.callId);
    const acknowledgementWithInvalidState = await caller.socket.emitWithAck('call:camera', { enabled: 'oui' });
    caller.socket.emit('call:camera', { enabled: true });
    await caller.socket.emitWithAck('chat:history');
    await callee.socket.emitWithAck('chat:history');

    expect(acknowledgementWithoutCall.error).toBe("Vous n'êtes dans aucun appel");
    expect(acknowledgementFromInvitee.error).toBe("Vous n'êtes dans aucun appel");
    expect(acknowledgementWithInvalidState.error).toBe('État de la caméra invalide');
    expect(cameraReceivedByCallee).not.toHaveBeenCalled();
  });

  async function startCallWithGuests(fileName, guestCount) {
    const createdFile = (await createFile(fileName, null, 'contenu')).body;
    const host = await createConnectedClient(createdFile.id, { name: 'Hôte' });
    const guests = [];
    for (let guestIndex = 0; guestIndex < guestCount; guestIndex += 1) {
      const guest = await createConnectedClient(createdFile.id, { name: `Invité ${guestIndex}` });
      await addToCall(host, guest);
      guests.push(guest);
    }
    return { createdFile, host, guests };
  }

  it('refuse une invitation au-delà de douze personnes dans un appel', async () => {
    const { createdFile, host } = await startCallWithGuests('appel-complet-douze.txt', 11);
    const extraPerson = await createConnectedClient(createdFile.id, { name: 'En trop' });

    const inviteAcknowledgement = await inviteCall(host.socket, extraPerson.clientId);

    expect(inviteAcknowledgement.error).toBe("L'appel est complet (12 personnes maximum)");
  });

  it('refuse une septième caméra allumée et libère la place quand une caméra se coupe ou quitte', async () => {
    const { host, guests } = await startCallWithGuests('appel-cameras.txt', 7);
    for (const guest of guests.slice(0, 6)) {
      expect(await guest.socket.emitWithAck('call:camera', { enabled: true })).toEqual({ enabled: true });
    }

    expect((await host.socket.emitWithAck('call:camera', { enabled: true })).error).toBe(
      '6 caméras sont déjà allumées dans cet appel',
    );
    expect(await guests[0].socket.emitWithAck('call:camera', { enabled: true })).toEqual({ enabled: true });

    await guests[0].socket.emitWithAck('call:camera', { enabled: false });
    expect(await host.socket.emitWithAck('call:camera', { enabled: true })).toEqual({ enabled: true });

    const leftReceivedByHost = waitForEvent(host.socket, 'call:left');
    guests[1].socket.emit('call:hangup');
    await leftReceivedByHost;
    expect(await guests[6].socket.emitWithAck('call:camera', { enabled: true })).toEqual({ enabled: true });
  });

  it('ne relaie pas les signaux entre deux appels différents', async () => {
    const createdFile = (await createFile('deux-appels.txt', null, 'contenu')).body;
    const alice = await createConnectedClient(createdFile.id, { name: 'Alice' });
    const bob = await createConnectedClient(createdFile.id, { name: 'Bob' });
    const carla = await createConnectedClient(createdFile.id, { name: 'Carla' });
    const david = await createConnectedClient(createdFile.id, { name: 'David' });
    await addToCall(alice, bob);
    await addToCall(carla, david);
    const signalReceivedByCarla = vi.fn();
    carla.socket.on('call:signal', signalReceivedByCarla);

    alice.socket.emit('call:signal', { targetClientId: carla.clientId, description: { type: 'offer', sdp: 'intrus' } });
    await alice.socket.emitWithAck('chat:history');
    await carla.socket.emitWithAck('chat:history');

    expect(signalReceivedByCarla).not.toHaveBeenCalled();
  });
});

describe('messagerie', () => {
  it("diffuse le message aux autres participants avec l'auteur authentifié, pas le nom envoyé par le client", async () => {
    const createdFile = (await createFile('chat.txt')).body;
    const socketA = await connectClient();
    const socketB = await connectClient();
    await joinDocument(socketA, createdFile.id, { name: 'Faux nom' });
    await joinDocument(socketB, createdFile.id, { name: 'Bob' });

    const messageReceivedByB = waitForEvent(socketB, 'chat:message');
    const sendAcknowledgement = await socketA.emitWithAck('chat:send', { text: 'Bonjour' });
    const receivedMessage = await messageReceivedByB;

    expect(sendAcknowledgement.error).toBeUndefined();
    expect(sendAcknowledgement.message).toEqual(receivedMessage);
    expect(receivedMessage).toMatchObject({ text: 'Bonjour', author: { name: 'Test Utilisateur' } });
    expect(receivedMessage.author.userId).toEqual(expect.any(Number));
  });

  it("n'envoie pas le message à son propre expéditeur ni aux autres documents", async () => {
    const chatFile = (await createFile('chat.txt')).body;
    const otherFile = (await createFile('autre.txt')).body;
    const sender = await connectClient();
    const otherDocumentReader = await connectClient();
    await joinDocument(sender, chatFile.id, { name: 'Alice' });
    await joinDocument(otherDocumentReader, otherFile.id, { name: 'Bob' });
    const receivedBySender = vi.fn();
    const receivedByOtherDocument = vi.fn();
    sender.on('chat:message', receivedBySender);
    otherDocumentReader.on('chat:message', receivedByOtherDocument);

    await sender.emitWithAck('chat:send', { text: 'Bonjour' });
    await otherDocumentReader.emitWithAck('chat:history');

    expect(receivedBySender).not.toHaveBeenCalled();
    expect(receivedByOtherDocument).not.toHaveBeenCalled();
  });

  it("donne l'historique de la session à un nouvel arrivant", async () => {
    const createdFile = (await createFile('chat.txt')).body;
    const firstParticipant = await connectClient();
    await joinDocument(firstParticipant, createdFile.id, { name: 'Alice' });
    await firstParticipant.emitWithAck('chat:send', { text: 'Premier' });
    await firstParticipant.emitWithAck('chat:send', { text: 'Second' });

    const newcomer = await connectClient();
    await joinDocument(newcomer, createdFile.id, { name: 'Bob' });
    const historyAcknowledgement = await newcomer.emitWithAck('chat:history');

    expect(historyAcknowledgement.messages.map((chatMessage) => chatMessage.text)).toEqual(['Premier', 'Second']);
  });

  it('refuse un message vide ou trop long', async () => {
    const createdFile = (await createFile('chat.txt')).body;
    const socket = await connectClient();
    await joinDocument(socket, createdFile.id, { name: 'Alice' });

    const emptyAcknowledgement = await socket.emitWithAck('chat:send', { text: '   ' });
    const tooLongAcknowledgement = await socket.emitWithAck('chat:send', { text: 'a'.repeat(1001) });

    expect(emptyAcknowledgement.error).toBe('Le message est vide');
    expect(tooLongAcknowledgement.error).toBe('Le message ne doit pas dépasser 1000 caractères');
  });

  it('refuse les messages et l’historique sans document rejoint', async () => {
    const socket = await connectClient();

    expect((await socket.emitWithAck('chat:send', { text: 'Bonjour' })).error).toBe('Aucun document rejoint');
    expect((await socket.emitWithAck('chat:history')).error).toBe('Aucun document rejoint');
  });

  it('efface les messages quand plus personne ne travaille sur le document', async () => {
    const createdFile = (await createFile('chat.txt')).body;
    const firstParticipant = await connectClient();
    await joinDocument(firstParticipant, createdFile.id, { name: 'Alice' });
    await firstParticipant.emitWithAck('chat:send', { text: 'Éphémère' });

    firstParticipant.disconnect();
    await vi.waitFor(() => expect(io.of('/').sockets.size).toBe(0), {
      timeout: WAIT_FOR_TIMEOUT_MS,
      interval: WAIT_FOR_INTERVAL_MS,
    });

    const nextParticipant = await connectClient();
    await joinDocument(nextParticipant, createdFile.id, { name: 'Bob' });
    const historyAcknowledgement = await nextParticipant.emitWithAck('chat:history');

    expect(historyAcknowledgement.messages).toEqual([]);
  });

  it("refuse les messages d'un utilisateur au-delà de la limite anti-spam", async () => {
    const { socketServer, port } = await startDedicatedCollaboration({
      storeDebounceMs: STORE_DEBOUNCE_MS,
      storeMaxDebounceMs: STORE_MAX_DEBOUNCE_MS,
      chatMessageLimit: 2,
      chatMessageWindowMs: 60000,
    });
    try {
      const createdFile = (await createFile('spam.txt')).body;
      const socket = await connectClient(sessionCookie, port);
      await joinDocument(socket, createdFile.id, { name: 'Alice' });

      await socket.emitWithAck('chat:send', { text: 'un' });
      const secondAcknowledgement = await socket.emitWithAck('chat:send', { text: 'deux' });
      const rejectedAcknowledgement = await socket.emitWithAck('chat:send', { text: 'trois' });

      expect(secondAcknowledgement.error).toBeUndefined();
      expect(rejectedAcknowledgement.error).toBe('Trop de messages envoyés : réessayez dans quelques secondes');
    } finally {
      await new Promise((resolve) => socketServer.close(resolve));
    }
  });
});

describe('limitation du débit des sockets', () => {
  it("refuse les messages d'un utilisateur au-delà de la limite de la fenêtre", async () => {
    const { socketServer, port } = await startDedicatedCollaboration({
      storeDebounceMs: STORE_DEBOUNCE_MS,
      storeMaxDebounceMs: STORE_MAX_DEBOUNCE_MS,
      socketEventLimit: 2,
      socketEventWindowMs: 60000,
    });
    try {
      const createdFile = (await createFile('debit.txt', null, 'abc')).body;
      const socket = await connectClient(sessionCookie, port);
      const joinAcknowledgement = await joinDocument(socket, createdFile.id, { name: 'Alice' });

      const acceptedAcknowledgement = await socket.emitWithAck('document:operation', {
        revision: joinAcknowledgement.revision,
        operation: [{ retain: 3 }, { insert: 'd' }],
      });
      const rejectedAcknowledgement = await socket.emitWithAck('document:operation', {
        revision: acceptedAcknowledgement.revision,
        operation: [{ retain: 4 }, { insert: 'e' }],
      });

      expect(acceptedAcknowledgement.error).toBeUndefined();
      expect(rejectedAcknowledgement.error).toBe('Trop de messages envoyés : réessayez dans un instant');
    } finally {
      await new Promise((resolve) => socketServer.close(resolve));
    }
  });
});

describe('droits d\'accès Socket.IO', () => {
  async function createSharedFile(permission) {
    const sharedFolder = (await createFolder('Partagé')).body;
    const sharedFile = (await createFile('partage.txt', sharedFolder.id, 'abc')).body;
    if (permission) {
      await authenticatedAgent.post(`/api/folders/${sharedFolder.id}/shares`).send({
        email: GUEST_TEST_EMAIL,
        permission,
      });
    }
    return sharedFile;
  }

  it('refuse le join sur un fichier sans accès', async () => {
    const privateFile = await createSharedFile(null);
    const guestSocket = await connectClient(guestSessionCookie);

    const joinAcknowledgement = await joinDocument(guestSocket, privateFile.id, { name: 'Invité' });

    expect(joinAcknowledgement.error).toBeDefined();
    expect(joinAcknowledgement.content).toBeUndefined();
  });

  it("renvoie la permission owner au propriétaire dans l'ack du join", async () => {
    const sharedFile = await createSharedFile('read');
    const ownerSocket = await connectClient();

    const joinAcknowledgement = await joinDocument(ownerSocket, sharedFile.id, { name: 'Propriétaire' });

    expect(joinAcknowledgement.permission).toBe('owner');
  });

  it.each(['read', 'write', 'delete'])("renvoie la permission %s à l'invité dans l'ack du join", async (permission) => {
    const sharedFile = await createSharedFile(permission);
    const guestSocket = await connectClient(guestSessionCookie);

    const joinAcknowledgement = await joinDocument(guestSocket, sharedFile.id, { name: 'Invité' });

    expect(joinAcknowledgement.error).toBeUndefined();
    expect(joinAcknowledgement.permission).toBe(permission);
    expect(joinAcknowledgement.content).toBe('abc');
  });

  it("refuse l'écriture d'un invité read et laisse le contenu intact", async () => {
    const sharedFile = await createSharedFile('read');
    const guestSocket = await connectClient(guestSessionCookie);
    const joinAcknowledgement = await joinDocument(guestSocket, sharedFile.id, { name: 'Invité' });

    const operationAcknowledgement = await guestSocket.emitWithAck('document:operation', {
      revision: joinAcknowledgement.revision,
      operation: [{ retain: 3 }, { insert: 'd' }],
    });
    const ownerSocket = await connectClient();
    const ownerJoinAcknowledgement = await joinDocument(ownerSocket, sharedFile.id, { name: 'Propriétaire' });

    expect(operationAcknowledgement.error).toBeDefined();
    expect(ownerJoinAcknowledgement.content).toBe('abc');
    expect(ownerJoinAcknowledgement.revision).toBe(0);
  });

  it("accepte l'écriture d'un invité write et sauvegarde le contenu", async () => {
    const sharedFile = await createSharedFile('write');
    const guestSocket = await connectClient(guestSessionCookie);
    const joinAcknowledgement = await joinDocument(guestSocket, sharedFile.id, { name: 'Invité' });

    const operationAcknowledgement = await guestSocket.emitWithAck('document:operation', {
      revision: joinAcknowledgement.revision,
      operation: [{ retain: 3 }, { insert: 'd' }],
    });

    expect(operationAcknowledgement.error).toBeUndefined();
    await vi.waitFor(
      async () => {
        const contentResponse = await authenticatedAgent.get(`/api/files/${sharedFile.id}/content`);
        expect(contentResponse.body.content).toBe('abcd');
      },
      { timeout: WAIT_FOR_TIMEOUT_MS, interval: WAIT_FOR_INTERVAL_MS },
    );
  });

  it("permet à un administrateur de rejoindre et modifier le fichier d'un autre utilisateur", async () => {
    const privateFile = await createSharedFile(null);
    const adminSocket = await connectClient(adminSessionCookie);

    const joinAcknowledgement = await joinDocument(adminSocket, privateFile.id, { name: 'Administrateur' });
    const operationAcknowledgement = await adminSocket.emitWithAck('document:operation', {
      revision: joinAcknowledgement.revision,
      operation: [{ retain: 3 }, { insert: 'd' }],
    });

    expect(joinAcknowledgement.error).toBeUndefined();
    expect(joinAcknowledgement.permission).toBe('owner');
    expect(joinAcknowledgement.content).toBe('abc');
    expect(operationAcknowledgement.error).toBeUndefined();
  });
});

describe('arrêt du serveur de collaboration', () => {
  it("sauvegarde les modifications encore en attente avant de fermer", async () => {
    const { collaboration, port } = await startDedicatedCollaboration({
      storeDebounceMs: 60000,
      storeMaxDebounceMs: 60000,
    });
    const createdFile = (await createFile('arret.txt', null, 'abc')).body;
    const socket = await connectClient(sessionCookie, port);
    const joinAcknowledgement = await joinDocument(socket, createdFile.id, { name: 'Alice' });
    await socket.emitWithAck('document:operation', {
      revision: joinAcknowledgement.revision,
      operation: [{ retain: 3 }, { insert: 'd' }],
    });
    const contentBeforeClose = await authenticatedAgent.get(`/api/files/${createdFile.id}/content`);

    await collaboration.close();

    const contentAfterClose = await authenticatedAgent.get(`/api/files/${createdFile.id}/content`);
    expect(contentBeforeClose.body.content).toBe('abc');
    expect(contentAfterClose.body.content).toBe('abcd');
  });
});
