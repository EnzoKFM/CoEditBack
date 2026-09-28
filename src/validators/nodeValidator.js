import { HttpError } from '../errors/HttpError.js';

const NODE_TYPES = ['folder', 'file'];
const NAME_MAX_LENGTH = 255;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

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

export function validateVersion(rawVersion) {
  if (!Number.isInteger(rawVersion) || rawVersion <= 0) {
    throw new HttpError(400, 'La version doit être un entier positif');
  }
  return rawVersion;
}
