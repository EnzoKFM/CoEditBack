import { Router } from 'express';
import { listFolderChildren, listRootChildren } from '../controllers/nodeController.js';
import {
  deleteFolderShare,
  listFolderShares,
  listSharedFolders,
  shareFolder,
  updateFolderShare,
} from '../controllers/shareController.js';

export const folderRoutes = Router();

folderRoutes.get('/root/children', listRootChildren);
folderRoutes.get('/shared', listSharedFolders);
folderRoutes.get('/:folderId/children', listFolderChildren);
folderRoutes.get('/:folderId/shares', listFolderShares);
folderRoutes.post('/:folderId/shares', shareFolder);
folderRoutes.patch('/:folderId/shares/:userId', updateFolderShare);
folderRoutes.delete('/:folderId/shares/:userId', deleteFolderShare);
