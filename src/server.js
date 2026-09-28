import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { pool } from './db.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.CLIENT_URL }));
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, async () => {
  console.log(`API démarrée sur http://localhost:${PORT}`);

  try {
    await pool.query('SELECT 1');
    console.log('Connexion MySQL OK');
  } catch (err) {
    console.error('Connexion MySQL impossible :', err.code || err.message);
  }
});
