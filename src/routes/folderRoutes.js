import { Router } from 'express';
import { listFolderChildren, listRootChildren } from '../controllers/nodeController.js';

export const folderRoutes = Router();

folderRoutes.get('/root/children', listRootChildren);
folderRoutes.get('/:folderId/children', listFolderChildren);
