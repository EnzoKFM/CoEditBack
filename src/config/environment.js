export function checkClientUrl() {
  const clientUrl = process.env.CLIENT_URL;
  let parsedClientUrl;
  try {
    parsedClientUrl = new URL(clientUrl);
  } catch {
    parsedClientUrl = null;
  }
  const isHttpOrigin =
    parsedClientUrl !== null &&
    ['http:', 'https:'].includes(parsedClientUrl.protocol) &&
    parsedClientUrl.origin === clientUrl;
  if (!isHttpOrigin) {
    throw new Error("CLIENT_URL doit être une origine http(s) sans chemin ni slash final, par exemple http://localhost:5173 (voir .env.example)");
  }
}

export function parseTrustProxy(rawTrustProxy) {
  if (rawTrustProxy === undefined || rawTrustProxy === '') {
    return null;
  }
  if (!/^\d+$/.test(rawTrustProxy)) {
    throw new Error('TRUST_PROXY doit être un entier supérieur ou égal à 0 (voir .env.example)');
  }
  return Number(rawTrustProxy);
}

export function checkTrustProxy() {
  parseTrustProxy(process.env.TRUST_PROXY);
}
