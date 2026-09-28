import { Router } from 'express';
import { getCurrentUser, login, loginWithTwoFactor, logout } from '../controllers/authController.js';
import { requireAuth } from '../middlewares/auth.js';
import { loginLimiter } from '../middlewares/loginLimiter.js';

export const authRoutes = Router();

authRoutes.post('/login', loginLimiter, login);
authRoutes.post('/login/2fa', loginLimiter, loginWithTwoFactor);
authRoutes.post('/logout', logout);
authRoutes.get('/me', requireAuth, getCurrentUser);
