import { Router } from 'express';
import { changePassword, updateProfile } from '../controllers/profileController.js';
import { requireAuth } from '../middlewares/auth.js';
import { passwordCheckLimiter } from '../middlewares/rateLimiters.js';

// Profil du compte connecté
export const profileRoutes = Router();

profileRoutes.patch('/', requireAuth, passwordCheckLimiter, updateProfile);
profileRoutes.patch('/password', requireAuth, passwordCheckLimiter, changePassword);
