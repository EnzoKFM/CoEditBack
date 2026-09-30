import { HttpError } from '../errors/HttpError.js';
import * as nodeService from '../services/nodeService.js';
import {
  parseNodeId,
  parseParentId,
  parseUploadedBinaryFile,
  validateContent,
  validateNodeName,
  validateNodeType,
} from '../validators/nodeValidator.js';

export async function listRootChildren(request, response) {
  response.json(await nodeService.listFolderChildren(null, request.user));
}

export async function listFolderChildren(request, response) {
  const folderId = parseNodeId(request.params.folderId);
  response.json(await nodeService.listFolderChildren(folderId, request.user));
}

export async function createNode(request, response) {
  const requestBody = request.body ?? {};
  const type = validateNodeType(requestBody.type);
  const createdNode = await nodeService.createNode({
    parentId: parseParentId(requestBody.parentId),
    type,
    name: validateNodeName(requestBody.name),
    content: type === 'file' ? validateContent(requestBody.content ?? '') : null,
    user: request.user,
  });
  response.status(201).json(createdNode);
}

export async function getNode(request, response) {
  const nodeId = parseNodeId(request.params.nodeId);
  response.json(await nodeService.getNode(nodeId, request.user));
}

export async function updateNode(request, response) {
  const nodeId = parseNodeId(request.params.nodeId);
  const requestBody = request.body ?? {};
  const isRenameRequested = requestBody.name !== undefined;
  const isMoveRequested = requestBody.parentId !== undefined;

  if (!isRenameRequested && !isMoveRequested) {
    throw new HttpError(400, 'Indiquer un nouveau nom (name) ou un nouveau dossier parent (parentId)');
  }

  const updatedNode = await nodeService.updateNode(nodeId, request.user, {
    name: isRenameRequested ? validateNodeName(requestBody.name) : undefined,
    parentId: isMoveRequested ? parseParentId(requestBody.parentId) : undefined,
    isMoveRequested,
  });
  response.json(updatedNode);
}

export async function deleteNode(request, response) {
  const nodeId = parseNodeId(request.params.nodeId);
  await nodeService.deleteNode(nodeId, request.user);
  response.status(204).end();
}

export async function getFileContent(request, response) {
  const fileId = parseNodeId(request.params.fileId);
  response.json(await nodeService.getFileContent(fileId, request.user));
}

export async function uploadBinaryFile(request, response) {
  const requestBody = request.body ?? {};
  const uploadedBinaryFile = await parseUploadedBinaryFile(request.file);
  const createdNode = await nodeService.createNode({
    parentId: parseParentId(requestBody.parentId),
    type: 'file',
    name: validateNodeName(requestBody.name ?? uploadedBinaryFile.originalName),
    binaryFile: { mimeType: uploadedBinaryFile.mimeType, data: uploadedBinaryFile.data },
    user: request.user,
  });
  response.status(201).json(createdNode);
}

export async function downloadBinaryFile(request, response) {
  const fileId = parseNodeId(request.params.fileId);
  const binaryFile = await nodeService.getBinaryFile(fileId, request.user);
  response.attachment(binaryFile.name);
  response.type(binaryFile.mimeType);
  response.send(binaryFile.data);
}

export async function replaceBinaryFile(request, response) {
  const fileId = parseNodeId(request.params.fileId);
  const uploadedBinaryFile = await parseUploadedBinaryFile(request.file);
  const replacedNode = await nodeService.replaceBinaryFile(fileId, request.user, {
    mimeType: uploadedBinaryFile.mimeType,
    data: uploadedBinaryFile.data,
  });
  response.json(replacedNode);
}
