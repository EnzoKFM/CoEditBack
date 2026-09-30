import * as shareService from '../services/shareService.js';
import { parseUserId } from '../validators/userValidator.js';
import { parseNodeId } from '../validators/nodeValidator.js';
import { validateShareBody, validateSharePermission } from '../validators/shareValidator.js';

export async function listSharedFolders(request, response) {
  response.json({ folders: await shareService.listSharedFolders(request.user.id) });
}

export async function listFolderShares(request, response) {
  const folderId = parseNodeId(request.params.folderId);
  response.json({ shares: await shareService.listFolderShares(folderId, request.user) });
}

export async function shareFolder(request, response) {
  const folderId = parseNodeId(request.params.folderId);
  const createdShare = await shareService.shareFolder(folderId, request.user, validateShareBody(request.body));
  response.status(201).json(createdShare);
}

export async function updateFolderShare(request, response) {
  const folderId = parseNodeId(request.params.folderId);
  const inviteeId = parseUserId(request.params.userId);
  const permission = validateSharePermission(request.body?.permission);
  response.json(await shareService.updateFolderShare(folderId, request.user, inviteeId, permission));
}

export async function deleteFolderShare(request, response) {
  const folderId = parseNodeId(request.params.folderId);
  const inviteeId = parseUserId(request.params.userId);
  await shareService.deleteFolderShare(folderId, request.user, inviteeId);
  response.status(204).end();
}
