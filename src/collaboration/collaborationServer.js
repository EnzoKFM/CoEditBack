import cookieParser from 'cookie-parser';
import { Server } from 'socket.io';
import { accessChanges } from '../lib/accessChanges.js';
import { authenticateSocket, findSocketUser } from '../middlewares/auth.js';
import { findFileAccess, findFileDocument } from '../services/nodeService.js';
import { AudioCallRegistry, listOtherParticipants } from './audioCallRegistry.js';
import { DocumentSession, ResyncRequiredError } from './documentSession.js';
import { createEventRateLimiter } from './eventRateLimiter.js';

const DEFAULT_STORE_DEBOUNCE_MS = 2000;
const DEFAULT_STORE_MAX_DEBOUNCE_MS = 10000;
const DEFAULT_MAX_HISTORY_LENGTH = 1000;
const DEFAULT_MAX_HISTORY_SIZE = 1000000;
const DEFAULT_MAX_DOCUMENT_LENGTH = 5000000;
const DEFAULT_SOCKET_EVENT_LIMIT = 100;
const DEFAULT_SOCKET_EVENT_WINDOW_MS = 1000;
const DEFAULT_CHAT_MESSAGE_LIMIT = 10;
const DEFAULT_CHAT_MESSAGE_WINDOW_MS = 10000;
const DEFAULT_ACCESS_CHECK_INTERVAL_MS = 60000;
const DEFAULT_MAX_SOCKETS_PER_USER = 20;
const MAX_SOCKET_MESSAGE_BYTES = 1000000;
const MAX_USER_NAME_LENGTH = 100;
const USER_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const DEFAULT_USER_NAME = 'Anonyme';
const MAX_SESSION_DESCRIPTION_LENGTH = 100000;
const MAX_ICE_CANDIDATE_LENGTH = 2000;
const SESSION_DESCRIPTION_TYPES = new Set(['offer', 'answer']);

function parseFileId(rawFileId) {
  const fileId = Number(rawFileId);
  if (!Number.isInteger(fileId) || fileId <= 0) {
    throw new Error('Identifiant de fichier invalide');
  }
  return fileId;
}

function parseUser(rawUser, authenticatedUser) {
  const userName = `${authenticatedUser.firstName} ${authenticatedUser.lastName}`.trim().slice(0, MAX_USER_NAME_LENGTH);
  const userColor = typeof rawUser?.color === 'string' && USER_COLOR_PATTERN.test(rawUser.color) ? rawUser.color : null;
  return { name: userName || DEFAULT_USER_NAME, color: userColor };
}

function parseCallSignal(signalRequest) {
  const description = signalRequest?.description;
  if (description) {
    const isValidDescription =
      SESSION_DESCRIPTION_TYPES.has(description.type) &&
      typeof description.sdp === 'string' &&
      description.sdp.length <= MAX_SESSION_DESCRIPTION_LENGTH;
    return isValidDescription ? { description: { type: description.type, sdp: description.sdp } } : null;
  }
  const candidate = signalRequest?.candidate;
  if (candidate && typeof candidate.candidate === 'string' && candidate.candidate.length <= MAX_ICE_CANDIDATE_LENGTH) {
    return {
      candidate: {
        candidate: candidate.candidate,
        sdpMid: typeof candidate.sdpMid === 'string' ? candidate.sdpMid : null,
        sdpMLineIndex: Number.isInteger(candidate.sdpMLineIndex) ? candidate.sdpMLineIndex : null,
        usernameFragment: typeof candidate.usernameFragment === 'string' ? candidate.usernameFragment : null,
      },
    };
  }
  return null;
}

function toRoomName(fileId) {
  return `file:${fileId}`;
}

export function createCollaboration({
  storeDebounceMs = DEFAULT_STORE_DEBOUNCE_MS,
  storeMaxDebounceMs = DEFAULT_STORE_MAX_DEBOUNCE_MS,
  maxHistoryLength = DEFAULT_MAX_HISTORY_LENGTH,
  maxHistorySize = DEFAULT_MAX_HISTORY_SIZE,
  maxDocumentLength = DEFAULT_MAX_DOCUMENT_LENGTH,
  socketEventLimit = DEFAULT_SOCKET_EVENT_LIMIT,
  socketEventWindowMs = DEFAULT_SOCKET_EVENT_WINDOW_MS,
  chatMessageLimit = DEFAULT_CHAT_MESSAGE_LIMIT,
  chatMessageWindowMs = DEFAULT_CHAT_MESSAGE_WINDOW_MS,
  accessCheckIntervalMs = DEFAULT_ACCESS_CHECK_INTERVAL_MS,
  maxSocketsPerUser = DEFAULT_MAX_SOCKETS_PER_USER,
} = {}) {
  const sessionPromisesByFileId = new Map();
  const audioCallRegistry = new AudioCallRegistry();
  const isSocketEventAllowed = createEventRateLimiter({ maxEvents: socketEventLimit, windowMs: socketEventWindowMs });
  const isChatMessageAllowed = createEventRateLimiter({ maxEvents: chatMessageLimit, windowMs: chatMessageWindowMs });
  let socketServer = null;
  let stopAccessWatching = () => {};

  function loadSession(fileId) {
    const existingSessionPromise = sessionPromisesByFileId.get(fileId);
    if (existingSessionPromise) {
      return existingSessionPromise;
    }

    const sessionPromise = findFileDocument(fileId).then((fileDocument) => {
      if (!fileDocument) {
        throw new Error('Fichier introuvable');
      }
      const session = new DocumentSession({
        fileId,
        content: fileDocument.content,
        revision: fileDocument.revision,
        storeDebounceMs,
        storeMaxDebounceMs,
        maxHistoryLength,
        maxHistorySize,
        maxDocumentLength,
        onStored: () => {
          if (!session.hasCollaborators()) {
            unloadSessionIfIdle(session);
          }
        },
      });
      return session;
    });
    sessionPromisesByFileId.set(fileId, sessionPromise);
    sessionPromise.catch(() => {
      if (sessionPromisesByFileId.get(fileId) === sessionPromise) {
        sessionPromisesByFileId.delete(fileId);
      }
    });
    return sessionPromise;
  }

  async function unloadSessionIfIdle(session) {
    await session.store();
    const sessionPromise = sessionPromisesByFileId.get(session.fileId);
    if (!sessionPromise || (await sessionPromise) !== session) {
      return;
    }
    if (!session.hasCollaborators() && !session.hasUnstoredChanges()) {
      sessionPromisesByFileId.delete(session.fileId);
    }
  }

  function attachToHttpServer(httpServer) {
    const io = new Server(httpServer, {
      cors: { origin: process.env.CLIENT_URL, credentials: true },
      maxHttpBufferSize: MAX_SOCKET_MESSAGE_BYTES,
    });
    socketServer = io;
    io.engine.use(cookieParser());
    io.use(authenticateSocket);
    io.use((socket, next) => {
      const userSocketCount = [...io.of('/').sockets.values()].filter(
        (connectedSocket) => connectedSocket.data.user?.id === socket.data.user.id,
      ).length;
      if (userSocketCount >= maxSocketsPerUser) {
        next(new Error('Trop de connexions simultanées'));
        return;
      }
      next();
    });

    function emitToClients(clientIds, eventName, payload) {
      if (clientIds.length > 0) {
        io.to(clientIds).emit(eventName, payload);
      }
    }

    function listSessionCalls(session) {
      const callsById = new Map();
      for (const collaborator of session.listCollaborators()) {
        const call = audioCallRegistry.findCallOfClient(collaborator.clientId);
        if (call && call.participantClientIds.size >= 2) {
          callsById.set(call.callId, { callId: call.callId, participantClientIds: [...call.participantClientIds] });
        }
      }
      return [...callsById.values()];
    }

    function broadcastCallStatus(session) {
      if (session) {
        io.to(toRoomName(session.fileId)).emit('call:status', { calls: listSessionCalls(session) });
      }
    }

    function hangUpCall(socket) {
      const call = audioCallRegistry.findCallOfClient(socket.id);
      if (!call) {
        return;
      }
      const { wasInvited, isEnded } = audioCallRegistry.leaveCall(call, socket.id);
      const reason = wasInvited ? 'declined' : 'hangup';
      if (isEnded) {
        emitToClients([...call.participantClientIds, ...call.invitedClientIds], 'call:ended', {
          callId: call.callId,
          reason,
        });
      } else {
        emitToClients([...call.participantClientIds], 'call:left', { callId: call.callId, clientId: socket.id, reason });
      }
      if (!wasInvited) {
        broadcastCallStatus(socket.data.session);
      }
    }

    async function leaveDocument(socket) {
      const session = socket.data.session;
      if (!session) {
        return;
      }
      hangUpCall(socket);
      socket.data.session = null;
      session.removeCollaborator(socket.id);
      socket.leave(toRoomName(session.fileId));
      io.to(toRoomName(session.fileId)).emit('presence:leave', { clientId: socket.id });
      if (!session.hasCollaborators()) {
        await unloadSessionIfIdle(session);
      }
    }

    function runExclusivelyForSocket(socket, task) {
      const previousTask = socket.data.pendingTask ?? Promise.resolve();
      const currentTask = previousTask.then(task);
      socket.data.pendingTask = currentTask.catch(() => {});
      return currentTask;
    }

    async function revalidateSocketAccess(socket) {
      const user = await findSocketUser(socket);
      if (!user) {
        socket.disconnect(true);
        return;
      }
      socket.data.user = user;
      const session = socket.data.session;
      if (!session) {
        return;
      }
      const fileAccess = await findFileAccess(session.fileId, user);
      if (socket.data.session !== session) {
        return;
      }
      if (!fileAccess) {
        await leaveDocument(socket);
        socket.emit('document:revoked', { fileId: session.fileId });
        return;
      }
      if (fileAccess.canEdit !== socket.data.canEditDocument) {
        socket.data.canEditDocument = fileAccess.canEdit;
        socket.emit('document:permission', { fileId: session.fileId, permission: fileAccess.permission });
      }
    }

    async function revalidateAllSockets() {
      const connectedSockets = [...io.of('/').sockets.values()];
      await Promise.allSettled(
        connectedSockets.map((connectedSocket) =>
          runExclusivelyForSocket(connectedSocket, () => revalidateSocketAccess(connectedSocket)).catch((error) =>
            console.error('Revalidation des droits impossible :', error.message),
          ),
        ),
      );
    }

    accessChanges.on('change', revalidateAllSockets);
    const accessCheckTimer = setInterval(revalidateAllSockets, accessCheckIntervalMs);
    accessCheckTimer.unref();
    stopAccessWatching = () => {
      accessChanges.off('change', revalidateAllSockets);
      clearInterval(accessCheckTimer);
    };
    httpServer.once('close', stopAccessWatching);

    io.on('connection', (socket) => {
      socket.use(([, ...eventArguments], next) => {
        if (isSocketEventAllowed(socket.data.user.id)) {
          next();
          return;
        }
        const acknowledge = eventArguments.at(-1);
        if (typeof acknowledge === 'function') {
          acknowledge({ error: 'Trop de messages envoyés : réessayez dans un instant' });
        }
      });

      socket.on('document:join', (joinRequest, acknowledge) => {
        if (typeof acknowledge !== 'function') {
          return;
        }
        runExclusivelyForSocket(socket, () => joinDocument(socket, joinRequest, acknowledge));
      });

      async function joinDocument(socket, joinRequest, acknowledge) {
        try {
          const fileId = parseFileId(joinRequest?.fileId);
          const fileAccess = await findFileAccess(fileId, socket.data.user);
          if (!fileAccess) {
            throw new Error('Fichier introuvable');
          }
          await leaveDocument(socket);
          const session = await loadSession(fileId);
          if (socket.disconnected) {
            await unloadSessionIfIdle(session);
            return;
          }
          const collaborator = session.addCollaborator(socket.id, parseUser(joinRequest?.user, socket.data.user));
          socket.data.session = session;
          socket.data.canEditDocument = fileAccess.canEdit;
          socket.join(toRoomName(fileId));
          socket.to(toRoomName(fileId)).emit('presence:update', collaborator);
          acknowledge({
            clientId: socket.id,
            permission: fileAccess.permission,
            content: session.content,
            revision: session.revision,
            collaborators: session
              .listCollaborators()
              .filter((otherCollaborator) => otherCollaborator.clientId !== socket.id),
          });
        } catch (error) {
          acknowledge({ error: error.message });
        }
      }

      socket.on('document:operation', (operationRequest, acknowledge) => {
        if (typeof acknowledge !== 'function') {
          return;
        }
        const session = socket.data.session;
        if (!session) {
          acknowledge({ error: 'Aucun document rejoint' });
          return;
        }
        if (!socket.data.canEditDocument) {
          acknowledge({ error: "Vous n'avez pas le droit de modifier ce document" });
          return;
        }
        try {
          const { revision, operation } = session.receiveOperation(
            operationRequest?.revision,
            operationRequest?.operation,
            socket.data.user.id,
          );
          socket.to(toRoomName(session.fileId)).emit('document:operation', {
            clientId: socket.id,
            revision,
            operation,
          });
          acknowledge({ revision });
        } catch (error) {
          acknowledge({ error: error.message, isResyncRequired: error instanceof ResyncRequiredError });
        }
      });

      socket.on('presence:update', (presence) => {
        const session = socket.data.session;
        const collaborator = session?.updatePresence(socket.id, presence ?? {});
        if (collaborator) {
          socket.to(toRoomName(session.fileId)).emit('presence:update', collaborator);
        }
      });

      socket.on('chat:send', (chatRequest, acknowledge) => {
        if (typeof acknowledge !== 'function') {
          return;
        }
        const session = socket.data.session;
        if (!session) {
          acknowledge({ error: 'Aucun document rejoint' });
          return;
        }
        if (!isChatMessageAllowed(socket.data.user.id)) {
          acknowledge({ error: 'Trop de messages envoyés : réessayez dans quelques secondes' });
          return;
        }
        try {
          const { id: userId, firstName, lastName } = socket.data.user;
          const chatMessage = session.addChatMessage({ userId, name: `${firstName} ${lastName}` }, chatRequest?.text);
          socket.to(toRoomName(session.fileId)).emit('chat:message', chatMessage);
          acknowledge({ message: chatMessage });
        } catch (error) {
          acknowledge({ error: error.message });
        }
      });

      socket.on('chat:history', (...eventArguments) => {
        const acknowledge = eventArguments.at(-1);
        if (typeof acknowledge !== 'function') {
          return;
        }
        const session = socket.data.session;
        if (!session) {
          acknowledge({ error: 'Aucun document rejoint' });
          return;
        }
        acknowledge({ messages: session.listChatMessages() });
      });

      socket.on('call:invite', (inviteRequest, acknowledge) => {
        if (typeof acknowledge !== 'function') {
          return;
        }
        const session = socket.data.session;
        if (!session) {
          acknowledge({ error: 'Aucun document rejoint' });
          return;
        }
        const callee = session.findCollaborator(inviteRequest?.targetClientId);
        if (!callee) {
          acknowledge({ error: 'Correspondant absent du document' });
          return;
        }
        try {
          const call = audioCallRegistry.inviteToCall({ inviterClientId: socket.id, inviteeClientId: callee.clientId });
          const caller = session.findCollaborator(socket.id);
          io.to(callee.clientId).emit('call:incoming', {
            callId: call.callId,
            caller: { clientId: caller.clientId, user: caller.user },
          });
          acknowledge({ callId: call.callId });
        } catch (error) {
          acknowledge({ error: error.message });
        }
      });

      socket.on('call:accept', (acceptRequest, acknowledge) => {
        if (typeof acknowledge !== 'function') {
          return;
        }
        try {
          const call = audioCallRegistry.acceptCall(acceptRequest?.callId, socket.id);
          const otherParticipantClientIds = listOtherParticipants(call, socket.id);
          emitToClients(otherParticipantClientIds, 'call:accepted', { callId: call.callId, clientId: socket.id });
          const participants = otherParticipantClientIds
            .map((participantClientId) => socket.data.session?.findCollaborator(participantClientId))
            .filter(Boolean)
            .map((participant) => ({ clientId: participant.clientId, user: participant.user }));
          acknowledge({ callId: call.callId, participants });
          broadcastCallStatus(socket.data.session);
        } catch (error) {
          acknowledge({ error: error.message });
        }
      });

      socket.on('call:status', (...eventArguments) => {
        const acknowledge = eventArguments.at(-1);
        if (typeof acknowledge !== 'function') {
          return;
        }
        const session = socket.data.session;
        if (!session) {
          acknowledge({ error: 'Aucun document rejoint' });
          return;
        }
        acknowledge({ calls: listSessionCalls(session) });
      });

      socket.on('call:join-request', (joinRequest, acknowledge) => {
        if (typeof acknowledge !== 'function') {
          return;
        }
        const session = socket.data.session;
        if (!session) {
          acknowledge({ error: 'Aucun document rejoint' });
          return;
        }
        try {
          const call = audioCallRegistry.findCallForJoinRequest(joinRequest?.callId, socket.id);
          const participantClientIds = [...call.participantClientIds];
          if (!participantClientIds.every((participantClientId) => session.findCollaborator(participantClientId))) {
            throw new Error('Appel introuvable');
          }
          const requester = session.findCollaborator(socket.id);
          emitToClients(participantClientIds, 'call:join-request', {
            callId: call.callId,
            requester: { clientId: requester.clientId, user: requester.user },
          });
          acknowledge({ callId: call.callId });
        } catch (error) {
          acknowledge({ error: error.message });
        }
      });

      socket.on('call:join-decline', (declineRequest) => {
        const call = audioCallRegistry.findCallOfClient(socket.id);
        const requesterClientId = declineRequest?.requesterClientId;
        if (!call?.participantClientIds.has(socket.id) || !socket.data.session?.findCollaborator(requesterClientId)) {
          return;
        }
        emitToClients([requesterClientId, ...listOtherParticipants(call, socket.id)], 'call:join-declined', {
          callId: call.callId,
          requesterClientId,
        });
      });

      socket.on('call:signal', (signalRequest) => {
        const targetClientId = signalRequest?.targetClientId;
        const callSignal = parseCallSignal(signalRequest);
        if (callSignal && audioCallRegistry.isInAcceptedCallWith(socket.id, targetClientId)) {
          io.to(targetClientId).emit('call:signal', { clientId: socket.id, ...callSignal });
        }
      });

      socket.on('call:mute', (muteRequest) => {
        const call = audioCallRegistry.findCallOfClient(socket.id);
        if (!call?.participantClientIds.has(socket.id) || typeof muteRequest?.muted !== 'boolean') {
          return;
        }
        emitToClients(listOtherParticipants(call, socket.id), 'call:mute', {
          clientId: socket.id,
          muted: muteRequest.muted,
        });
      });

      socket.on('call:camera', (cameraRequest, acknowledge) => {
        if (typeof acknowledge !== 'function') {
          return;
        }
        const call = audioCallRegistry.findCallOfClient(socket.id);
        if (!call?.participantClientIds.has(socket.id)) {
          acknowledge({ error: "Vous n'êtes dans aucun appel" });
          return;
        }
        if (typeof cameraRequest?.enabled !== 'boolean') {
          acknowledge({ error: 'État de la caméra invalide' });
          return;
        }
        try {
          audioCallRegistry.setCamera(call, socket.id, cameraRequest.enabled);
        } catch (error) {
          acknowledge({ error: error.message });
          return;
        }
        emitToClients(listOtherParticipants(call, socket.id), 'call:camera', {
          clientId: socket.id,
          enabled: cameraRequest.enabled,
        });
        acknowledge({ enabled: cameraRequest.enabled });
      });

      socket.on('call:hangup', () => hangUpCall(socket));

      socket.on('document:leave', () => leaveDocument(socket));
      socket.on('disconnect', () => leaveDocument(socket));
    });

    return io;
  }

  async function close() {
    const sessionPromises = [...sessionPromisesByFileId.values()];
    stopAccessWatching();
    socketServer?.close();
    const sessionResults = await Promise.allSettled(sessionPromises);
    const loadedSessions = sessionResults
      .filter((sessionResult) => sessionResult.status === 'fulfilled')
      .map((sessionResult) => sessionResult.value);
    await Promise.all(loadedSessions.map((loadedSession) => loadedSession.store()));
  }

  return { attachToHttpServer, close };
}
