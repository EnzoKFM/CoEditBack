import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Chiffrement des secrets 2FA avant leur stockage en base :
// une fuite de la base seule ne permet plus de générer les codes des utilisateurs.
// AES-256-GCM chiffre et signe : un secret modifié en base est détecté au déchiffrement.
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_PATTERN = /^[0-9a-f]{64}$/i;

// Clé de 32 octets, écrite en hexadécimal (64 caractères) dans le .env
function getEncryptionKey() {
  const hexKey = process.env.TOTP_ENCRYPTION_KEY;
  if (!KEY_PATTERN.test(hexKey ?? '')) {
    throw new Error('TOTP_ENCRYPTION_KEY doit contenir 64 caractères hexadécimaux (voir .env.example)');
  }
  return Buffer.from(hexKey, 'hex');
}

// Vérifié au démarrage du serveur
export function checkEncryptionKey() {
  getEncryptionKey();
}

// Renvoie "iv.tag.texteChiffré" (base64url) : tout ce qu'il faut pour déchiffrer, sauf la clé
export function encryptSecret(plainSecret) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encryptedSecret = Buffer.concat([cipher.update(plainSecret, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, encryptedSecret].map((part) => part.toString('base64url')).join('.');
}

// Lance une erreur si la clé a changé ou si la valeur a été modifiée
export function decryptSecret(storedSecret) {
  const [iv, authTag, encryptedSecret] = storedSecret.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encryptedSecret), decipher.final()]).toString('utf8');
}
