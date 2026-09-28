import { Hocuspocus } from '@hocuspocus/server';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { findFileDocument, storeFileDocument } from '../services/nodeService.js';

export const COLLABORATION_PATH = '/collaboration';
export const DOCUMENT_TEXT_NAME = 'content';

const DEFAULT_STORE_DEBOUNCE_MS = 2000;
const DEFAULT_STORE_MAX_DEBOUNCE_MS = 10000;
const FILE_ID_PATTERN = /^[1-9]\d*$/;

function parseFileId(documentName) {
  if (!FILE_ID_PATTERN.test(documentName)) {
    throw new Error(`Nom de document invalide : ${documentName}`);
  }
  return Number(documentName);
}

async function getExistingFileDocument(documentName) {
  const fileDocument = await findFileDocument(parseFileId(documentName));
  if (!fileDocument) {
    throw new Error(`Fichier introuvable : ${documentName}`);
  }
  return fileDocument;
}

function toYjsState(document) {
  return Buffer.from(Y.encodeStateAsUpdate(document));
}

async function createInitialYjsState(documentName, content) {
  const initialDocument = new Y.Doc();
  initialDocument.getText(DOCUMENT_TEXT_NAME).insert(0, content);
  const initialYjsState = toYjsState(initialDocument);
  await storeFileDocument(parseFileId(documentName), { content, yjsState: initialYjsState });
  return initialYjsState;
}

function toFetchRequest(incomingRequest, requestUrl) {
  const requestHeaders = new Headers();
  for (const [headerName, headerValue] of Object.entries(incomingRequest.headers)) {
    if (headerValue !== undefined) {
      requestHeaders.set(headerName, Array.isArray(headerValue) ? headerValue.join(', ') : headerValue);
    }
  }
  return new Request(requestUrl, { headers: requestHeaders });
}

export function createCollaboration({
  storeDebounceMs = DEFAULT_STORE_DEBOUNCE_MS,
  storeMaxDebounceMs = DEFAULT_STORE_MAX_DEBOUNCE_MS,
} = {}) {
  const hocuspocus = new Hocuspocus({
    debounce: storeDebounceMs,
    maxDebounce: storeMaxDebounceMs,
    quiet: true,

    async onConnect({ documentName }) {
      await getExistingFileDocument(documentName);
    },

    async onLoadDocument({ documentName }) {
      const fileDocument = await getExistingFileDocument(documentName);
      const yjsState = fileDocument.yjsState ?? (await createInitialYjsState(documentName, fileDocument.content));
      return new Uint8Array(yjsState);
    },

    async onStoreDocument({ document, documentName }) {
      await storeFileDocument(parseFileId(documentName), {
        content: document.getText(DOCUMENT_TEXT_NAME).toString(),
        yjsState: toYjsState(document),
      });
    },
  });

  function attachToHttpServer(httpServer) {
    const webSocketServer = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (incomingRequest, socket, head) => {
      const requestUrl = new URL(incomingRequest.url, 'http://localhost');
      if (requestUrl.pathname !== COLLABORATION_PATH) {
        socket.destroy();
        return;
      }

      webSocketServer.handleUpgrade(incomingRequest, socket, head, (websocket) => {
        const clientConnection = hocuspocus.handleConnection(websocket, toFetchRequest(incomingRequest, requestUrl));
        websocket.on('message', (messageData) => clientConnection.handleMessage(new Uint8Array(messageData)));
        websocket.on('close', (closeCode, closeReason) => {
          clientConnection.handleClose({ code: closeCode, reason: closeReason.toString() });
        });
        websocket.on('error', (error) => console.error('Erreur WebSocket de collaboration :', error.message));
      });
    });
  }

  return { hocuspocus, attachToHttpServer };
}
