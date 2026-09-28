import { Router } from 'express';
import { getFileContent } from '../controllers/nodeController.js';

export const fileRoutes = Router();

fileRoutes.get('/:fileId/content', getFileContent);
