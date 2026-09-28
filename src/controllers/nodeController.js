import { HttpError } from '../errors/HttpError.js';
import * as nodeService from '../services/nodeService.js';
import {
  parseNodeId,
  parseParentId,
  validateContent,
  validateNodeName,
  validateNodeType,
  validateVersion,
} from '../validators/nodeValidator.js';

export async function listRootChildren(request, response) {
  response.json(await nodeService.listFolderChildren(null));
}

export async function listFolderChildren(request, response) {
  const folderId = parseNodeId(request.params.folderId);
  response.json(await nodeService.listFolderChildren(folderId));
}

export async function createNode(request, response) {
  const requestBody = request.body ?? {};
  const type = validateNodeType(requestBody.type);
  const createdNode = await nodeService.createNode({
    parentId: parseParentId(requestBody.parentId),
    type,
    name: validateNodeName(requestBody.name),
    content: type === 'file' ? validateContent(requestBody.content ?? '') : null,
  });
  response.status(201).json(createdNode);
}

export async function getNode(request, response) {
  const nodeId = parseNodeId(request.params.nodeId);
  response.json(await nodeService.getNode(nodeId));
}

export async function updateNode(request, response) {
  const nodeId = parseNodeId(request.params.nodeId);
  const requestBody = request.body ?? {};
  const isRenameRequested = requestBody.name !== undefined;
  const isMoveRequested = requestBody.parentId !== undefined;

  if (!isRenameRequested && !isMoveRequested) {
    throw new HttpError(400, 'Indiquer un nouveau nom (name) ou un nouveau dossier parent (parentId)');
  }

  const updatedNode = await nodeService.updateNode(nodeId, {
    name: isRenameRequested ? validateNodeName(requestBody.name) : undefined,
    parentId: isMoveRequested ? parseParentId(requestBody.parentId) : undefined,
    isMoveRequested,
  });
  response.json(updatedNode);
}

export async function deleteNode(request, response) {
  const nodeId = parseNodeId(request.params.nodeId);
  await nodeService.deleteNode(nodeId);
  response.status(204).end();
}

export async function getFileContent(request, response) {
  const fileId = parseNodeId(request.params.fileId);
  response.json(await nodeService.getFileContent(fileId));
}

export async function saveFileContent(request, response) {
  const fileId = parseNodeId(request.params.fileId);
  const requestBody = request.body ?? {};
  const savedFile = await nodeService.saveFileContent(fileId, {
    content: validateContent(requestBody.content),
    version: validateVersion(requestBody.version),
  });
  response.json(savedFile);
}
