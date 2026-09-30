import { HttpError } from '../errors/HttpError.js';
import { validateEmail } from './authValidator.js';

const SHARE_PERMISSIONS = ['read', 'write', 'delete'];

export function validateSharePermission(rawPermission) {
  if (!SHARE_PERMISSIONS.includes(rawPermission)) {
    throw new HttpError(400, `La permission doit valoir ${SHARE_PERMISSIONS.join(', ')}`);
  }
  return rawPermission;
}

export function validateShareBody(requestBody) {
  const { email, permission } = requestBody ?? {};
  return { email: validateEmail(email), permission: validateSharePermission(permission) };
}
