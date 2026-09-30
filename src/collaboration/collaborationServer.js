import cookieParser from 'cookie-parser';
import { Server } from 'socket.io';
import { authenticateSocket } from '../middlewares/auth.js';
import { findFileAccess, findFileDocument } from '../services/nodeService.js';
import { AudioCallRegistry, getPeerClientId } from './audioCallRegistry.js';
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
const MAX_SOCKET_MESSAGE_BYTES = 1000000;
const MAX_USER_NAME_LENGTH = 100;
const MAX_USER_COLOR_LENGTH = 32;
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

function parseUser(rawUser) {
  const userName = typeof rawUser?.name === 'string' ? rawUser.name.trim().slice(0, MAX_USER_NAME_LENGTH) : '';
  const userColor = typeof rawUser?.color === 'string' ? rawUser.color.slice(0, MAX_USER_COLOR_LENGTH) : null;
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
} = {}) {
  const sessionPromisesByFileId = new Map();
  const audioCallRegistry = new AudioCallRegistry();
  const isSocketEventAllowed = createEventRateLimiter({ maxEvents: socketEventLimit, windowMs: socketEventWindowMs });
  const isChatMessageAllowed = createEventRateLimiter({ maxEvents: chatMessageLimit, windowMs: chatMessageWindowMs });
  let socketServer = null;

  function loadSession(fileId) {
    const existingSessionPromise = sessionPromisesByFileId.get(fileId);
    if (existingSessionPromise) {
      return existingSessionPromise;
    }

    const sessionPromise = findFileDocument(fileId).then((fileDocument) => {
      if (!fileDocument) {
        throw new Error('Fichier introuvable');
      }
      return new DocumentSession({
        fileId,
        content: fileDocument.content,
        revision: fileDocument.revision,
        storeDebounceMs,
        storeMaxDebounceMs,
        maxHistoryLength,
        maxHistorySize,
        maxDocumentLength,
      });
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
    if (!session.hasCollaborators() && sessionPromise && (await sessionPromise) === session) {
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

    function hangUpCall(socket) {
      const call = audioCallRegistry.findCallOfClient(socket.id);
      if (!call) {
        return;
      }
      audioCallRegistry.endCall(call);
      const isDeclined = !call.isAccepted && call.calleeClientId === socket.id;
      io.to(getPeerClientId(call, socket.id)).emit('call:ended', {
        callId: call.callId,
        reason: isDeclined ? 'declined' : 'hangup',
      });
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

      socket.on('document:join', async (joinRequest, acknowledge) => {
        if (typeof acknowledge !== 'function') {
          return;
        }
        try {
          const fileId = parseFileId(joinRequest?.fileId);
          const fileAccess = await findFileAccess(fileId, socket.data.user);
          if (!fileAccess) {
            throw new Error('Fichier introuvable');
          }
          await leaveDocument(socket);
          const session = await loadSession(fileId);
          const collaborator = session.addCollaborator(socket.id, parseUser(joinRequest?.user));
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
      });

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
          const call = audioCallRegistry.startCall({ callerClientId: socket.id, calleeClientId: callee.clientId });
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
          io.to(call.callerClientId).emit('call:accepted', { callId: call.callId, clientId: socket.id });
          acknowledge({ callId: call.callId });
        } catch (error) {
          acknowledge({ error: error.message });
        }
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
        if (!call?.isAccepted || typeof muteRequest?.muted !== 'boolean') {
          return;
        }
        io.to(getPeerClientId(call, socket.id)).emit('call:mute', { clientId: socket.id, muted: muteRequest.muted });
      });

      socket.on('call:hangup', () => hangUpCall(socket));

      socket.on('document:leave', () => leaveDocument(socket));
      socket.on('disconnect', () => leaveDocument(socket));
    });

    return io;
  }

  async function close() {
    const sessionPromises = [...sessionPromisesByFileId.values()];
    socketServer?.close();
    const sessionResults = await Promise.allSettled(sessionPromises);
    const loadedSessions = sessionResults
      .filter((sessionResult) => sessionResult.status === 'fulfilled')
      .map((sessionResult) => sessionResult.value);
    await Promise.all(loadedSessions.map((loadedSession) => loadedSession.store()));
  }

  return { attachToHttpServer, close };
}
