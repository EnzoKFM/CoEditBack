import { Router } from 'express';
import { getFileContent, saveFileContent } from '../controllers/nodeController.js';

export const fileRoutes = Router();

fileRoutes.get('/:fileId/content', getFileContent);
fileRoutes.put('/:fileId/content', saveFileContent);
