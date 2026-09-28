import express from 'express';
import cors from 'cors';
import { errorHandler } from './middlewares/errorHandler.js';
import { fileRoutes } from './routes/fileRoutes.js';
import { folderRoutes } from './routes/folderRoutes.js';
import { nodeRoutes } from './routes/nodeRoutes.js';

export const app = express();

app.use(cors({ origin: process.env.CLIENT_URL }));
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/folders', folderRoutes);
app.use('/api/nodes', nodeRoutes);
app.use('/api/files', fileRoutes);

app.use(errorHandler);
