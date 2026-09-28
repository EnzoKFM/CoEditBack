import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { errorHandler } from './middlewares/errorHandler.js';
import { authRoutes } from './routes/authRoutes.js';
import { fileRoutes } from './routes/fileRoutes.js';
import { folderRoutes } from './routes/folderRoutes.js';
import { nodeRoutes } from './routes/nodeRoutes.js';
import { twoFactorRoutes } from './routes/twoFactorRoutes.js';

export const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRoutes);
app.use('/api/users/me/2fa', twoFactorRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/nodes', nodeRoutes);
app.use('/api/files', fileRoutes);

app.use(errorHandler);
