import { storeFileDocument } from '../services/nodeService.js';
import {
  InvalidOperationError,
  applyOperation,
  parseOperation,
  transformIndex,
  transformOperation,
} from './textOperation.js';

export class ResyncRequiredError extends Error {}

export class DocumentSession {
  constructor({
    fileId,
    content,
    revision,
    storeDebounceMs,
    storeMaxDebounceMs,
    maxHistoryLength,
    maxHistorySize,
    maxDocumentLength,
  }) {
    this.fileId = fileId;
    this.content = content;
    this.revision = revision;
    this.queuedStoreRevision = revision;
    this.historyStartRevision = revision;
    this.operationHistory = [];
    this.historySize = 0;
    this.maxHistoryLength = maxHistoryLength;
    this.maxHistorySize = maxHistorySize;
    this.maxDocumentLength = maxDocumentLength;
    this.collaboratorsByClientId = new Map();
    this.storeDebounceMs = storeDebounceMs;
    this.storeMaxDebounceMs = storeMaxDebounceMs;
    this.storeTimer = null;
    this.firstUnstoredChangeAt = null;
    this.storeQueue = Promise.resolve();
  }

  addCollaborator(clientId, user) {
    const collaborator = { clientId, user, selection: null, pointer: null };
    this.collaboratorsByClientId.set(clientId, collaborator);
    return collaborator;
  }

  removeCollaborator(clientId) {
    this.collaboratorsByClientId.delete(clientId);
  }

  findCollaborator(clientId) {
    return this.collaboratorsByClientId.get(clientId) ?? null;
  }

  hasCollaborators() {
    return this.collaboratorsByClientId.size > 0;
  }

  listCollaborators() {
    return [...this.collaboratorsByClientId.values()];
  }

  updatePresence(clientId, { selection, pointer }) {
    const collaborator = this.collaboratorsByClientId.get(clientId);
    if (!collaborator) {
      return null;
    }
    collaborator.selection = this.parseSelection(selection);
    collaborator.pointer = parsePointer(pointer);
    return collaborator;
  }

  parseSelection(selection) {
    const isValidIndex = (index) => Number.isInteger(index) && index >= 0 && index <= this.content.length;
    if (!selection || !isValidIndex(selection.anchor) || !isValidIndex(selection.head)) {
      return null;
    }
    return { anchor: selection.anchor, head: selection.head };
  }

  receiveOperation(baseRevision, rawOperation) {
    if (!Number.isInteger(baseRevision) || baseRevision > this.revision) {
      throw new InvalidOperationError('Révision de base invalide');
    }
    if (baseRevision < this.historyStartRevision) {
      throw new ResyncRequiredError('Révision trop ancienne : rechargez le document');
    }

    let operation = parseOperation(rawOperation);
    for (const concurrentOperation of this.operationHistory.slice(baseRevision - this.historyStartRevision)) {
      [operation] = transformOperation(operation, concurrentOperation);
    }

    const updatedContent = applyOperation(this.content, operation);
    if (updatedContent.length > this.maxDocumentLength) {
      throw new InvalidOperationError(`Le document ne doit pas dépasser ${this.maxDocumentLength} caractères`);
    }

    this.content = updatedContent;
    this.recordInHistory(operation);
    this.revision += 1;
    this.transformSelections(operation);
    this.scheduleStore();
    return { revision: this.revision, operation };
  }

  recordInHistory(operation) {
    this.operationHistory.push(operation);
    this.historySize += getOperationSize(operation);
    while (this.operationHistory.length > this.maxHistoryLength || this.historySize > this.maxHistorySize) {
      const forgottenOperation = this.operationHistory.shift();
      this.historySize -= getOperationSize(forgottenOperation);
      this.historyStartRevision += 1;
    }
  }

  transformSelections(operation) {
    for (const collaborator of this.collaboratorsByClientId.values()) {
      if (collaborator.selection) {
        collaborator.selection = {
          anchor: transformIndex(collaborator.selection.anchor, operation),
          head: transformIndex(collaborator.selection.head, operation),
        };
      }
    }
  }

  scheduleStore() {
    clearTimeout(this.storeTimer);
    this.firstUnstoredChangeAt ??= Date.now();
    const remainingMaxDelay = this.firstUnstoredChangeAt + this.storeMaxDebounceMs - Date.now();
    const storeDelay = Math.max(0, Math.min(this.storeDebounceMs, remainingMaxDelay));
    this.storeTimer = setTimeout(() => this.store(), storeDelay);
  }

  store() {
    clearTimeout(this.storeTimer);
    this.storeTimer = null;
    this.firstUnstoredChangeAt = null;

    const contentToStore = this.content;
    const revisionToStore = this.revision;
    if (revisionToStore === this.queuedStoreRevision) {
      return this.storeQueue;
    }

    this.queuedStoreRevision = revisionToStore;
    this.storeQueue = this.storeQueue
      .then(() => storeFileDocument(this.fileId, { content: contentToStore, revision: revisionToStore }))
      .catch((error) => console.error(`Sauvegarde du fichier ${this.fileId} impossible :`, error.message));
    return this.storeQueue;
  }
}

function getOperationSize(operation) {
  let operationSize = operation.length;
  for (const component of operation) {
    if (typeof component.insert === 'string') {
      operationSize += component.insert.length;
    }
  }
  return operationSize;
}

function parsePointer(pointer) {
  if (!pointer || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) {
    return null;
  }
  return { x: pointer.x, y: pointer.y };
}
