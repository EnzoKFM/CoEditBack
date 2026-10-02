import { fileTypeFromBuffer, supportedMimeTypes } from 'file-type';
import { HttpError } from '../errors/HttpError.js';

const NODE_TYPES = ['folder', 'file'];
const NAME_MAX_LENGTH = 255;
const FORBIDDEN_NAME_CHARACTERS_PATTERN = /[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const RESERVED_NAMES = ['.', '..'];
const SAFE_DECLARED_MIME_TYPES = new Set(['text/plain', 'text/csv', 'text/markdown', 'application/json']);
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const MIME_TYPE_MAX_LENGTH = 255;
const DEFAULT_MIME_TYPE = 'application/octet-stream';

export function parseNodeId(rawNodeId) {
  if (!['string', 'number'].includes(typeof rawNodeId) || !POSITIVE_INTEGER_PATTERN.test(String(rawNodeId))) {
    throw new HttpError(400, 'Identifiant invalide');
  }
  return Number(rawNodeId);
}

export function parseParentId(rawParentId) {
  if (rawParentId === null || rawParentId === undefined) {
    return null;
  }
  return parseNodeId(rawParentId);
}

export function validateNodeName(rawName) {
  if (typeof rawName !== 'string') {
    throw new HttpError(400, 'Le nom est obligatoire');
  }

  const trimmedName = rawName.trim();
  if (trimmedName === '') {
    throw new HttpError(400, 'Le nom est obligatoire');
  }
  if (trimmedName.length > NAME_MAX_LENGTH) {
    throw new HttpError(400, `Le nom ne doit pas dépasser ${NAME_MAX_LENGTH} caractères`);
  }
  if (trimmedName.includes('/')) {
    throw new HttpError(400, 'Le nom ne doit pas contenir de « / »');
  }
  if (FORBIDDEN_NAME_CHARACTERS_PATTERN.test(trimmedName)) {
    throw new HttpError(400, 'Le nom ne doit pas contenir de caractères de contrôle');
  }
  if (RESERVED_NAMES.includes(trimmedName)) {
    throw new HttpError(400, 'Ce nom est réservé');
  }
  return trimmedName;
}

export function validateNodeType(rawType) {
  if (!NODE_TYPES.includes(rawType)) {
    throw new HttpError(400, `Le type doit valoir ${NODE_TYPES.join(' ou ')}`);
  }
  return rawType;
}

export function validateContent(rawContent) {
  if (typeof rawContent !== 'string') {
    throw new HttpError(400, 'Le contenu doit être une chaîne de caractères');
  }
  return rawContent;
}

function validateUploadedFile(uploadedFile) {
  if (!uploadedFile) {
    throw new HttpError(400, 'Le fichier est obligatoire (champ « file »)');
  }
  return uploadedFile;
}

function parseMimeType(rawMimeType) {
  const normalizedMimeType = typeof rawMimeType === 'string' ? rawMimeType.trim().toLowerCase() : '';
  const isValidMimeType =
    normalizedMimeType.length <= MIME_TYPE_MAX_LENGTH && MIME_TYPE_PATTERN.test(normalizedMimeType);
  return isValidMimeType ? normalizedMimeType : DEFAULT_MIME_TYPE;
}

export async function parseUploadedBinaryFile(rawUploadedFile) {
  const uploadedFile = validateUploadedFile(rawUploadedFile);
  const declaredMimeType = parseMimeType(uploadedFile.mimetype);
  const detectedFileType = await fileTypeFromBuffer(uploadedFile.buffer);
  const isDeclaredMimeTypeGeneric = declaredMimeType === DEFAULT_MIME_TYPE;

  if (detectedFileType && !isDeclaredMimeTypeGeneric && detectedFileType.mime !== declaredMimeType) {
    throw new HttpError(
      400,
      `Le contenu du fichier (${detectedFileType.mime}) ne correspond pas au type déclaré (${declaredMimeType})`,
    );
  }
  if (!detectedFileType && supportedMimeTypes.has(declaredMimeType)) {
    throw new HttpError(400, `Le contenu du fichier ne correspond pas au type déclaré (${declaredMimeType})`);
  }

  const storableDeclaredMimeType = SAFE_DECLARED_MIME_TYPES.has(declaredMimeType) ? declaredMimeType : DEFAULT_MIME_TYPE;

  return {
    originalName: uploadedFile.originalname,
    mimeType: detectedFileType?.mime ?? storableDeclaredMimeType,
    data: uploadedFile.buffer,
  };
}
