import { Router } from 'express';
import { blockUser, createUserAccount, listAllUsers, unblockUser } from '../controllers/adminUserController.js';
import { requireAdmin, requireAuth } from '../middlewares/auth.js';

// Gestion des comptes, réservée aux administrateurs
export const adminUserRoutes = Router();

adminUserRoutes.use(requireAuth, requireAdmin);

adminUserRoutes.get('/', listAllUsers);
adminUserRoutes.post('/', createUserAccount);
adminUserRoutes.patch('/:userId/block', blockUser);
adminUserRoutes.patch('/:userId/unblock', unblockUser);
