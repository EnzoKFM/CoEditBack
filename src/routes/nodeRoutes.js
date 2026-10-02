import { Router } from 'express';
import { createNode, deleteNode, getNode, updateNode } from '../controllers/nodeController.js';

export const nodeRoutes = Router();

nodeRoutes.post('/', createNode);
nodeRoutes.get('/:nodeId', getNode);
nodeRoutes.patch('/:nodeId', updateNode);
nodeRoutes.delete('/:nodeId', deleteNode);
