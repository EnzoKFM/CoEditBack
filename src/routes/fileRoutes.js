import { Router } from 'express';
import multer from 'multer';
import {
  downloadBinaryFile,
  getFileContent,
  replaceBinaryFile,
  uploadBinaryFile,
} from '../controllers/nodeController.js';
import { binaryFileUploadLimiter } from '../middlewares/rateLimiters.js';

export const BINARY_FILE_MAX_BYTES = 20 * 1024 * 1024;

const binaryFileUpload = multer({
  defParamCharset: 'utf8',
  limits: { fileSize: BINARY_FILE_MAX_BYTES, files: 1, fields: 2, parts: 3, fieldSize: 1024 },
}).single('file');

export const fileRoutes = Router();

fileRoutes.post('/', binaryFileUploadLimiter, binaryFileUpload, uploadBinaryFile);
fileRoutes.get('/:fileId/content', getFileContent);
fileRoutes.get('/:fileId/binary', downloadBinaryFile);
fileRoutes.put('/:fileId/binary', binaryFileUploadLimiter, binaryFileUpload, replaceBinaryFile);
