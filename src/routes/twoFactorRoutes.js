import { Router } from 'express';
import { disableTwoFactor, enableTwoFactor, setupTwoFactor } from '../controllers/twoFactorController.js';
import { requireAuth } from '../middlewares/auth.js';
import { passwordCheckLimiter } from '../middlewares/rateLimiters.js';

// Gestion de la 2FA du compte connecté
export const twoFactorRoutes = Router();

twoFactorRoutes.use(requireAuth);

twoFactorRoutes.post('/setup', passwordCheckLimiter, setupTwoFactor);
twoFactorRoutes.post('/enable', enableTwoFactor);
twoFactorRoutes.post('/disable', passwordCheckLimiter, disableTwoFactor);
