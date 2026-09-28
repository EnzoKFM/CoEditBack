import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';

// Nom affiché dans l'application d'authentification (Google Authenticator, Authy…)
const ISSUER = 'CoEdit';

// Tolérance de 30 s avant/après : absorbe un léger décalage d'horloge
// et un code saisi juste au moment où il change.
const EPOCH_TOLERANCE_SECONDS = 30;

// Génère un nouveau secret TOTP (base32, compatible avec les applications)
export function createTotpSecret() {
  return generateSecret();
}

// Construit le QR code à scanner, sous forme d'image (data URL) affichable dans un <img>
export async function buildTotpQrCode(email, secret) {
  const otpauthUri = generateURI({ issuer: ISSUER, label: email, secret });
  return QRCode.toDataURL(otpauthUri);
}

// Vérifie un code à 6 chiffres pour un secret donné
export async function isTotpCodeValid(secret, code) {
  try {
    const result = await verify({ secret, token: code, epochTolerance: EPOCH_TOLERANCE_SECONDS });
    return result.valid;
  } catch {
    return false;
  }
}
