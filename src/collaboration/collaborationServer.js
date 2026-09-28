import { Server } from 'socket.io';
import { findFileDocument } from '../services/nodeService.js';
import { DocumentSession, ResyncRequiredError } from './documentSession.js';

const DEFAULT_STORE_DEBOUNCE_MS = 2000;
const DEFAULT_STORE_MAX_DEBOUNCE_MS = 10000;
const MAX_USER_NAME_LENGTH = 100;
const MAX_USER_COLOR_LENGTH = 32;
const DEFAULT_USER_NAME = 'Anonyme';

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

function toRoomName(fileId) {
  return `file:${fileId}`;
}

export function createCollaboration({
  storeDebounceMs = DEFAULT_STORE_DEBOUNCE_MS,
  storeMaxDebounceMs = DEFAULT_STORE_MAX_DEBOUNCE_MS,
} = {}) {
  const sessionPromisesByFileId = new Map();

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
    const io = new Server(httpServer, { cors: { origin: process.env.CLIENT_URL } });

    async function leaveDocument(socket) {
      const session = socket.data.session;
      if (!session) {
        return;
      }
      socket.data.session = null;
      session.removeCollaborator(socket.id);
      socket.leave(toRoomName(session.fileId));
      io.to(toRoomName(session.fileId)).emit('presence:leave', { clientId: socket.id });
      if (!session.hasCollaborators()) {
        await unloadSessionIfIdle(session);
      }
    }

    io.on('connection', (socket) => {
      socket.on('document:join', async (joinRequest, acknowledge) => {
        if (typeof acknowledge !== 'function') {
          return;
        }
        try {
          const fileId = parseFileId(joinRequest?.fileId);
          await leaveDocument(socket);
          const session = await loadSession(fileId);
          const collaborator = session.addCollaborator(socket.id, parseUser(joinRequest?.user));
          socket.data.session = session;
          socket.join(toRoomName(fileId));
          socket.to(toRoomName(fileId)).emit('presence:update', collaborator);
          acknowledge({
            clientId: socket.id,
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

      socket.on('document:leave', () => leaveDocument(socket));
      socket.on('disconnect', () => leaveDocument(socket));
    });

    return io;
  }

  return { attachToHttpServer };
}
