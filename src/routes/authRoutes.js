import { Router } from 'express';
import { getCurrentUser, login, loginWithTwoFactor, logout } from '../controllers/authController.js';
import { requireAuth } from '../middlewares/auth.js';
import { loginLimiters, twoFactorLoginLimiter } from '../middlewares/rateLimiters.js';

export const authRoutes = Router();

authRoutes.post('/login', loginLimiters, login);
authRoutes.post('/login/2fa', twoFactorLoginLimiter, loginWithTwoFactor);
authRoutes.post('/logout', logout);
authRoutes.get('/me', requireAuth, getCurrentUser);
