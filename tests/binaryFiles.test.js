import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { pool } from '../src/db.js';
import { BINARY_FILE_UPLOAD_LIMIT } from '../src/middlewares/rateLimiters.js';
import { BINARY_FILE_MAX_BYTES } from '../src/routes/fileRoutes.js';
import { createAuthenticatedAgent, deleteTestUser } from './authHelper.js';
import { closeDatabase, resetDatabase } from './databaseHelper.js';

const OWNER_EMAIL = 'binaire-proprietaire@coedit.test';
const GUEST_EMAIL = 'binaire-invite@coedit.test';
const STRANGER_EMAIL = 'binaire-etranger@coedit.test';
const LIMITED_EMAIL = 'binaire-limite@coedit.test';
const UNLIMITED_EMAIL = 'binaire-non-limite@coedit.test';
const FORGED_EMAIL = 'binaire-falsifie@coedit.test';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const SHELL_SCRIPT_BYTES = Buffer.from('#!/bin/sh\necho "script malveillant"\n');
const PLAIN_TEXT_BYTES = Buffer.from('contenu texte brut sans signature reconnue');
const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0x01, 0xc3, 0x28]);

let ownerAgent;
let guestAgent;
let strangerAgent;
let forgedAgent;

beforeAll(async () => {
  ownerAgent = await createAuthenticatedAgent(OWNER_EMAIL);
  guestAgent = await createAuthenticatedAgent(GUEST_EMAIL);
  strangerAgent = await createAuthenticatedAgent(STRANGER_EMAIL);
  forgedAgent = await createAuthenticatedAgent(FORGED_EMAIL);
});
beforeEach(resetDatabase);
afterAll(async () => {
  await deleteTestUser(OWNER_EMAIL);
  await deleteTestUser(GUEST_EMAIL);
  await deleteTestUser(STRANGER_EMAIL);
  await deleteTestUser(FORGED_EMAIL);
  await deleteTestUser(LIMITED_EMAIL);
  await deleteTestUser(UNLIMITED_EMAIL);
  await closeDatabase();
});

function collectBinaryBody(binaryResponse, onParsed) {
  const chunks = [];
  binaryResponse.on('data', (chunk) => chunks.push(chunk));
  binaryResponse.on('end', () => onParsed(null, Buffer.concat(chunks)));
}

async function createFolder(agent, name, parentId = null) {
  return agent.post('/api/nodes').send({ type: 'folder', name, parentId });
}

async function createTextFile(agent, name, parentId = null, content = '') {
  return agent.post('/api/nodes').send({ type: 'file', name, parentId, content });
}

async function uploadBinary(agent, fileBytes, { filename = 'image.png', contentType = 'image/png', parentId, name } = {}) {
  let uploadRequest = agent.post('/api/files').attach('file', fileBytes, { filename, contentType });
  if (parentId !== undefined) {
    uploadRequest = uploadRequest.field('parentId', String(parentId));
  }
  if (name !== undefined) {
    uploadRequest = uploadRequest.field('name', name);
  }
  return uploadRequest;
}

async function replaceBinary(agent, fileId, fileBytes, { filename = 'nouveau.pdf', contentType = 'application/pdf' } = {}) {
  return agent.put(`/api/files/${fileId}/binary`).attach('file', fileBytes, { filename, contentType });
}

async function downloadBinary(agent, fileId) {
  return agent.get(`/api/files/${fileId}/binary`).buffer(true).parse(collectBinaryBody);
}

async function shareFolder(folderId, email, permission) {
  return ownerAgent.post(`/api/folders/${folderId}/shares`).send({ email, permission });
}

async function findBinaryRow(fileId) {
  const [binaryRows] = await pool.query('SELECT mime_type, size, version FROM file_binaries WHERE node_id = ?', [fileId]);
  return binaryRows[0];
}

describe('envoi de fichier binaire', () => {
  it('crée un fichier binaire à la racine avec son nom et son type MIME', async () => {
    const uploadResponse = await uploadBinary(ownerAgent, PNG_BYTES, { filename: 'logo.png' });

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body).toMatchObject({
      parentId: null,
      type: 'file',
      name: 'logo.png',
      mimeType: 'image/png',
    });
    expect(uploadResponse.body.id).toEqual(expect.any(Number));
    expect(uploadResponse.body.ownerId).toEqual(expect.any(Number));
    expect(uploadResponse.body.createdAt).toBeDefined();
    expect(uploadResponse.body.updatedAt).toBeDefined();
  });

  it('crée un fichier binaire dans un dossier', async () => {
    const parentFolder = (await createFolder(ownerAgent, 'Images')).body;

    const uploadResponse = await uploadBinary(ownerAgent, PNG_BYTES, { parentId: parentFolder.id });

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body.parentId).toBe(parentFolder.id);
  });

  it("utilise le champ name à la place du nom d'origine", async () => {
    const uploadResponse = await uploadBinary(ownerAgent, PNG_BYTES, { filename: 'origine.png', name: 'renommé.png' });

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body.name).toBe('renommé.png');
  });

  it("décode correctement en UTF-8 le nom d'origine accentué", async () => {
    const uploadResponse = await uploadBinary(ownerAgent, PDF_BYTES, {
      filename: 'Élève été 2024.pdf',
      contentType: 'application/pdf',
    });

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body.name).toBe('Élève été 2024.pdf');
  });

  it('renvoie 400 sans fichier', async () => {
    const uploadResponse = await ownerAgent.post('/api/files').field('name', 'vide.png');

    expect(uploadResponse.status).toBe(400);
    expect(uploadResponse.body.error).toBeDefined();
  });

  it('renvoie 400 pour un parentId invalide', async () => {
    const uploadResponse = await uploadBinary(ownerAgent, PNG_BYTES, { parentId: 'abc' });

    expect(uploadResponse.status).toBe(400);
  });

  it('renvoie 400 pour un parent inexistant', async () => {
    const uploadResponse = await uploadBinary(ownerAgent, PNG_BYTES, { parentId: 999999 });

    expect(uploadResponse.status).toBe(400);
  });

  it("renvoie 400 quand le parent est un fichier", async () => {
    const parentFile = (await createTextFile(ownerAgent, 'note.txt')).body;

    const uploadResponse = await uploadBinary(ownerAgent, PNG_BYTES, { parentId: parentFile.id });

    expect(uploadResponse.status).toBe(400);
  });

  it("renvoie 409 pour un nom en doublon dans le même dossier", async () => {
    await uploadBinary(ownerAgent, PNG_BYTES, { filename: 'doublon.png' });

    const duplicateResponse = await uploadBinary(ownerAgent, PDF_BYTES, {
      filename: 'doublon.png',
      contentType: 'application/pdf',
    });

    expect(duplicateResponse.status).toBe(409);
  });

  it("renvoie 409 quand le nom entre en conflit avec un document texte", async () => {
    await createTextFile(ownerAgent, 'conflit.txt');

    const duplicateResponse = await uploadBinary(ownerAgent, PNG_BYTES, { filename: 'conflit.txt' });

    expect(duplicateResponse.status).toBe(409);
  });

  it('retient text/plain, défaut de la RFC 7578, pour un type MIME invalide', async () => {
    const uploadResponse = await uploadBinary(ownerAgent, PLAIN_TEXT_BYTES, { contentType: 'pas-un-type-mime' });

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body.mimeType).toBe('text/plain');
  });

  it('retient text/plain, défaut de la RFC 7578, pour un type MIME mal formé contenant une barre', async () => {
    const uploadResponse = await uploadBinary(ownerAgent, PLAIN_TEXT_BYTES, { contentType: 'image /png' });

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body.mimeType).toBe('text/plain');
  });

  it("retient text/plain, défaut de la RFC 7578, en l'absence d'en-tête Content-Type de la partie", async () => {
    const multipartBoundary = 'frontiere-test';
    const multipartBody = Buffer.concat([
      Buffer.from(
        `--${multipartBoundary}\r\nContent-Disposition: form-data; name="file"; filename="sans-type.bin"\r\n\r\n`,
      ),
      PLAIN_TEXT_BYTES,
      Buffer.from(`\r\n--${multipartBoundary}--\r\n`),
    ]);

    const uploadResponse = await ownerAgent
      .post('/api/files')
      .set('Content-Type', `multipart/form-data; boundary=${multipartBoundary}`)
      .send(multipartBody);

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body.mimeType).toBe('text/plain');
  });

  it('accepte un fichier de la taille maximale', async () => {
    const maximumSizeBytes = Buffer.concat([PDF_BYTES, Buffer.alloc(BINARY_FILE_MAX_BYTES - PDF_BYTES.length, 7)]);

    const uploadResponse = await uploadBinary(ownerAgent, maximumSizeBytes, {
      filename: 'limite.pdf',
      contentType: 'application/pdf',
    });

    expect(uploadResponse.status).toBe(201);
    expect((await findBinaryRow(uploadResponse.body.id)).size).toBe(BINARY_FILE_MAX_BYTES);
  });

  it('renvoie 413 pour un fichier de plus de 20 Mo', async () => {
    const oversizedBytes = Buffer.alloc(BINARY_FILE_MAX_BYTES + 1, 7);

    const uploadResponse = await uploadBinary(ownerAgent, oversizedBytes, { filename: 'trop-gros.bin' });

    expect(uploadResponse.status).toBe(413);
    expect(uploadResponse.body.error).toContain('volumineux');
    const [nodeRows] = await pool.query("SELECT id FROM nodes WHERE name = 'trop-gros.bin'");
    expect(nodeRows).toHaveLength(0);
  });

  it('renvoie 401 sans session', async () => {
    const uploadResponse = await request(app)
      .post('/api/files')
      .attach('file', PNG_BYTES, { filename: 'x.png', contentType: 'image/png' });

    expect(uploadResponse.status).toBe(401);
  });

  it("renvoie 400 à un utilisateur sans accès au dossier parent, sans créer de nœud", async () => {
    const privateFolder = (await createFolder(ownerAgent, 'Privé')).body;

    const uploadResponse = await uploadBinary(strangerAgent, PNG_BYTES, { parentId: privateFolder.id });

    expect(uploadResponse.status).toBe(400);
    const [childRows] = await pool.query('SELECT id FROM nodes WHERE parent_id = ?', [privateFolder.id]);
    expect(childRows).toHaveLength(0);
  });

  it("renvoie 403 à un invité en lecture seule sur le dossier parent", async () => {
    const sharedFolder = (await createFolder(ownerAgent, 'Partagé')).body;
    await shareFolder(sharedFolder.id, GUEST_EMAIL, 'read');

    const uploadResponse = await uploadBinary(guestAgent, PNG_BYTES, { parentId: sharedFolder.id });

    expect(uploadResponse.status).toBe(403);
  });

  it("autorise un invité en écriture et attribue le fichier au propriétaire de l'arbre", async () => {
    const sharedFolder = (await createFolder(ownerAgent, 'Partagé')).body;
    await shareFolder(sharedFolder.id, GUEST_EMAIL, 'write');

    const uploadResponse = await uploadBinary(guestAgent, PNG_BYTES, { parentId: sharedFolder.id });

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body.ownerId).toBe(sharedFolder.ownerId);
  });
});

describe('téléchargement de fichier binaire', () => {
  it('renvoie des octets identiques avec le type MIME stocké', async () => {
    const uploadedFile = (await uploadBinary(ownerAgent, PNG_BYTES, { filename: 'logo.png' })).body;

    const downloadResponse = await downloadBinary(ownerAgent, uploadedFile.id);

    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers['content-type']).toContain('image/png');
    expect(Buffer.isBuffer(downloadResponse.body)).toBe(true);
    expect(downloadResponse.body.length).toBe(PNG_BYTES.length);
    expect(downloadResponse.body.equals(PNG_BYTES)).toBe(true);
  });

  it('renvoie un en-tête Content-Disposition attachment avec le nom', async () => {
    const uploadedFile = (await uploadBinary(ownerAgent, PNG_BYTES, { filename: 'logo.png' })).body;

    const downloadResponse = await downloadBinary(ownerAgent, uploadedFile.id);

    expect(downloadResponse.headers['content-disposition']).toMatch(/^attachment/);
    expect(downloadResponse.headers['content-disposition']).toContain('logo.png');
  });

  it('encode dans Content-Disposition un nom contenant des caractères hors latin-1', async () => {
    const uploadedFile = (await uploadBinary(ownerAgent, PDF_BYTES, {
      filename: 'Prix€.pdf',
      contentType: 'application/pdf',
    })).body;

    const downloadResponse = await downloadBinary(ownerAgent, uploadedFile.id);

    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers['content-disposition']).toContain(encodeURIComponent('Prix€.pdf'));
  });

  it('restitue un type MIME par défaut pour un fichier sans type', async () => {
    const uploadedFile = (await ownerAgent.post('/api/files').attach('file', PLAIN_TEXT_BYTES, { filename: 'brut.bin' })).body;

    const downloadResponse = await downloadBinary(ownerAgent, uploadedFile.id);

    expect(downloadResponse.headers['content-type']).toContain('application/octet-stream');
  });

  it('autorise un invité en lecture', async () => {
    const sharedFolder = (await createFolder(ownerAgent, 'Partagé')).body;
    await shareFolder(sharedFolder.id, GUEST_EMAIL, 'read');
    const uploadedFile = (await uploadBinary(ownerAgent, PNG_BYTES, { parentId: sharedFolder.id })).body;

    const downloadResponse = await downloadBinary(guestAgent, uploadedFile.id);

    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.body.equals(PNG_BYTES)).toBe(true);
  });

  it('renvoie 404 à un utilisateur sans accès', async () => {
    const uploadedFile = (await uploadBinary(ownerAgent, PNG_BYTES)).body;

    const downloadResponse = await strangerAgent.get(`/api/files/${uploadedFile.id}/binary`);

    expect(downloadResponse.status).toBe(404);
  });

  it('renvoie 404 pour un fichier inexistant', async () => {
    const downloadResponse = await ownerAgent.get('/api/files/999999/binary');

    expect(downloadResponse.status).toBe(404);
  });

  it('renvoie 400 pour un document texte', async () => {
    const textFile = (await createTextFile(ownerAgent, 'note.txt', null, 'Bonjour')).body;

    const downloadResponse = await ownerAgent.get(`/api/files/${textFile.id}/binary`);

    expect(downloadResponse.status).toBe(400);
  });

  it('renvoie 400 pour un dossier', async () => {
    const folder = (await createFolder(ownerAgent, 'Dossier')).body;

    const downloadResponse = await ownerAgent.get(`/api/files/${folder.id}/binary`);

    expect(downloadResponse.status).toBe(400);
  });

  it('renvoie 400 pour un identifiant invalide', async () => {
    const downloadResponse = await ownerAgent.get('/api/files/abc/binary');

    expect(downloadResponse.status).toBe(400);
  });

  it('renvoie 401 sans session', async () => {
    const uploadedFile = (await uploadBinary(ownerAgent, PNG_BYTES)).body;

    const downloadResponse = await request(app).get(`/api/files/${uploadedFile.id}/binary`);

    expect(downloadResponse.status).toBe(401);
  });
});

describe('remplacement de fichier binaire', () => {
  it('remplace le contenu et le type MIME, incrémente la version et garde le nom', async () => {
    const uploadedFile = (await uploadBinary(ownerAgent, PNG_BYTES, { filename: 'logo.png' })).body;
    expect((await findBinaryRow(uploadedFile.id)).version).toBe(1);

    const replaceResponse = await replaceBinary(ownerAgent, uploadedFile.id, PDF_BYTES);

    expect(replaceResponse.status).toBe(200);
    expect(replaceResponse.body).toMatchObject({ id: uploadedFile.id, name: 'logo.png', mimeType: 'application/pdf' });
    const binaryRow = await findBinaryRow(uploadedFile.id);
    expect(binaryRow.version).toBe(2);
    expect(binaryRow.size).toBe(PDF_BYTES.length);
    expect(binaryRow.mime_type).toBe('application/pdf');
    const downloadResponse = await downloadBinary(ownerAgent, uploadedFile.id);
    expect(downloadResponse.headers['content-type']).toContain('application/pdf');
    expect(downloadResponse.body.equals(PDF_BYTES)).toBe(true);
  });

  it('incrémente la version à chaque remplacement', async () => {
    const uploadedFile = (await uploadBinary(ownerAgent, PNG_BYTES)).body;

    await replaceBinary(ownerAgent, uploadedFile.id, PDF_BYTES);
    await replaceBinary(ownerAgent, uploadedFile.id, PNG_BYTES, { filename: 'nouveau.png', contentType: 'image/png' });

    expect((await findBinaryRow(uploadedFile.id)).version).toBe(3);
  });

  it('autorise un invité en écriture', async () => {
    const sharedFolder = (await createFolder(ownerAgent, 'Partagé')).body;
    await shareFolder(sharedFolder.id, GUEST_EMAIL, 'write');
    const uploadedFile = (await uploadBinary(ownerAgent, PNG_BYTES, { parentId: sharedFolder.id })).body;

    const replaceResponse = await replaceBinary(guestAgent, uploadedFile.id, PDF_BYTES);

    expect(replaceResponse.status).toBe(200);
    expect((await findBinaryRow(uploadedFile.id)).version).toBe(2);
  });

  it('renvoie 403 à un invité en lecture et laisse le contenu intact', async () => {
    const sharedFolder = (await createFolder(ownerAgent, 'Partagé')).body;
    await shareFolder(sharedFolder.id, GUEST_EMAIL, 'read');
    const uploadedFile = (await uploadBinary(ownerAgent, PNG_BYTES, { parentId: sharedFolder.id })).body;

    const replaceResponse = await replaceBinary(guestAgent, uploadedFile.id, PDF_BYTES);

    expect(replaceResponse.status).toBe(403);
    const binaryRow = await findBinaryRow(uploadedFile.id);
    expect(binaryRow.version).toBe(1);
    expect(binaryRow.mime_type).toBe('image/png');
  });

  it('renvoie 404 à un utilisateur sans accès', async () => {
    const uploadedFile = (await uploadBinary(ownerAgent, PNG_BYTES)).body;

    const replaceResponse = await replaceBinary(strangerAgent, uploadedFile.id, PDF_BYTES);

    expect(replaceResponse.status).toBe(404);
  });

  it('renvoie 400 pour un document texte et ne le transforme pas en binaire', async () => {
    const textFile = (await createTextFile(ownerAgent, 'note.txt', null, 'Bonjour')).body;

    const replaceResponse = await replaceBinary(ownerAgent, textFile.id, PDF_BYTES);

    expect(replaceResponse.status).toBe(400);
    expect(await findBinaryRow(textFile.id)).toBeUndefined();
    const contentResponse = await ownerAgent.get(`/api/files/${textFile.id}/content`);
    expect(contentResponse.status).toBe(200);
    expect(contentResponse.body.content).toBe('Bonjour');
  });

  it('renvoie 400 pour un dossier', async () => {
    const folder = (await createFolder(ownerAgent, 'Dossier')).body;

    const replaceResponse = await replaceBinary(ownerAgent, folder.id, PDF_BYTES);

    expect(replaceResponse.status).toBe(400);
  });

  it('renvoie 400 sans fichier', async () => {
    const uploadedFile = (await uploadBinary(ownerAgent, PNG_BYTES)).body;

    const replaceResponse = await ownerAgent.put(`/api/files/${uploadedFile.id}/binary`);

    expect(replaceResponse.status).toBe(400);
    expect((await findBinaryRow(uploadedFile.id)).version).toBe(1);
  });

  it('renvoie 413 pour un fichier de plus de 20 Mo et laisse le contenu intact', async () => {
    const uploadedFile = (await uploadBinary(ownerAgent, PNG_BYTES)).body;
    const oversizedBytes = Buffer.alloc(BINARY_FILE_MAX_BYTES + 1, 7);

    const replaceResponse = await replaceBinary(ownerAgent, uploadedFile.id, oversizedBytes);

    expect(replaceResponse.status).toBe(413);
    const downloadResponse = await downloadBinary(ownerAgent, uploadedFile.id);
    expect(downloadResponse.body.equals(PNG_BYTES)).toBe(true);
  });

  it('renvoie 401 sans session', async () => {
    const uploadedFile = (await uploadBinary(ownerAgent, PNG_BYTES)).body;

    const replaceResponse = await request(app)
      .put(`/api/files/${uploadedFile.id}/binary`)
      .attach('file', PDF_BYTES, { filename: 'x.pdf', contentType: 'application/pdf' });

    expect(replaceResponse.status).toBe(401);
  });
});

describe('interactions avec les autres routes', () => {
  it('renvoie 400 pour la lecture du contenu texte d\'un binaire', async () => {
    const [ownerRows] = await pool.query('SELECT id FROM users WHERE email = ?', [OWNER_EMAIL]);
    const [nodeInsertResult] = await pool.query(
      "INSERT INTO nodes (parent_id, type, name, owner_id) VALUES (NULL, 'file', 'image.png', ?)",
      [ownerRows[0].id],
    );
    await pool.query('INSERT INTO file_binaries (node_id, mime_type, data, size) VALUES (?, ?, ?, ?)', [
      nodeInsertResult.insertId,
      'image/png',
      PNG_BYTES,
      PNG_BYTES.length,
    ]);

    const contentResponse = await ownerAgent.get(`/api/files/${nodeInsertResult.insertId}/content`);

    expect(contentResponse.status).toBe(400);
    expect(contentResponse.body.error).toBe("Ce fichier n'est pas un document texte");
  });

  it('liste un binaire avec sa taille en octets et son type MIME, et un texte avec mimeType null', async () => {
    const parentFolder = (await createFolder(ownerAgent, 'Mixte')).body;
    await uploadBinary(ownerAgent, PNG_BYTES, { filename: 'logo.png', parentId: parentFolder.id });
    await createTextFile(ownerAgent, 'note.txt', parentFolder.id, 'Bonjour');

    const listingResponse = await ownerAgent.get(`/api/folders/${parentFolder.id}/children`);

    expect(listingResponse.status).toBe(200);
    const binaryChild = listingResponse.body.children.find((child) => child.name === 'logo.png');
    const textChild = listingResponse.body.children.find((child) => child.name === 'note.txt');
    expect(binaryChild.size).toBe(PNG_BYTES.length);
    expect(binaryChild.mimeType).toBe('image/png');
    expect(textChild.size).toBe('Bonjour'.length);
    expect(textChild.mimeType).toBeNull();
  });

  it('renvoie le mimeType sur GET /api/nodes/:id', async () => {
    const uploadedFile = (await uploadBinary(ownerAgent, PNG_BYTES)).body;
    const textFile = (await createTextFile(ownerAgent, 'note.txt')).body;

    const binaryNodeResponse = await ownerAgent.get(`/api/nodes/${uploadedFile.id}`);
    const textNodeResponse = await ownerAgent.get(`/api/nodes/${textFile.id}`);

    expect(binaryNodeResponse.body.mimeType).toBe('image/png');
    expect(textNodeResponse.body.mimeType).toBeNull();
  });

  it("supprime la ligne file_binaries avec le dossier qui contient le binaire", async () => {
    const parentFolder = (await createFolder(ownerAgent, 'ASupprimer')).body;
    const nestedFolder = (await createFolder(ownerAgent, 'Imbriqué', parentFolder.id)).body;
    const uploadedFile = (await uploadBinary(ownerAgent, PNG_BYTES, { parentId: nestedFolder.id })).body;
    expect(await findBinaryRow(uploadedFile.id)).toBeDefined();

    const deleteResponse = await ownerAgent.delete(`/api/nodes/${parentFolder.id}`);

    expect(deleteResponse.status).toBe(204);
    const [remainingBinaryRows] = await pool.query('SELECT node_id FROM file_binaries');
    expect(remainingBinaryRows).toHaveLength(0);
  });

  it('supprime un binaire seul', async () => {
    const uploadedFile = (await uploadBinary(ownerAgent, PNG_BYTES)).body;

    const deleteResponse = await ownerAgent.delete(`/api/nodes/${uploadedFile.id}`);

    expect(deleteResponse.status).toBe(204);
    expect(await findBinaryRow(uploadedFile.id)).toBeUndefined();
  });
});

async function countRowsCreatedByForgedUser() {
  const [nodeRows] = await pool.query('SELECT id FROM nodes');
  const [binaryRows] = await pool.query('SELECT node_id FROM file_binaries');
  return { nodeCount: nodeRows.length, binaryCount: binaryRows.length };
}

describe('cohérence entre le contenu et le type déclaré', () => {
  it('renvoie 400 pour un script shell renommé en .png déclaré image/png, sans créer de ligne', async () => {
    const uploadResponse = await uploadBinary(forgedAgent, SHELL_SCRIPT_BYTES, {
      filename: 'innocent.png',
      contentType: 'image/png',
    });

    expect(uploadResponse.status).toBe(400);
    expect(await countRowsCreatedByForgedUser()).toEqual({ nodeCount: 0, binaryCount: 0 });
  });

  it('renvoie 400 pour un PDF réel déclaré image/png', async () => {
    const uploadResponse = await uploadBinary(forgedAgent, PDF_BYTES, { filename: 'faux.png', contentType: 'image/png' });

    expect(uploadResponse.status).toBe(400);
    expect(uploadResponse.body.error).toContain('application/pdf');
    expect(await countRowsCreatedByForgedUser()).toEqual({ nodeCount: 0, binaryCount: 0 });
  });

  it('enregistre image/png pour un PNG réel déclaré application/octet-stream', async () => {
    const uploadResponse = await uploadBinary(forgedAgent, PNG_BYTES, {
      filename: 'generique.bin',
      contentType: 'application/octet-stream',
    });

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body.mimeType).toBe('image/png');
    expect((await findBinaryRow(uploadResponse.body.id)).mime_type).toBe('image/png');
  });

  it('accepte un texte brut déclaré text/plain', async () => {
    const uploadResponse = await uploadBinary(forgedAgent, PLAIN_TEXT_BYTES, {
      filename: 'note.txt',
      contentType: 'text/plain',
    });

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body.mimeType).toBe('text/plain');
  });

  it('renvoie 400 au remplacement par un script déclaré image/png et laisse le contenu intact', async () => {
    const uploadedFile = (await uploadBinary(forgedAgent, PNG_BYTES, { filename: 'logo.png' })).body;

    const replaceResponse = await replaceBinary(forgedAgent, uploadedFile.id, SHELL_SCRIPT_BYTES, {
      filename: 'innocent.png',
      contentType: 'image/png',
    });

    expect(replaceResponse.status).toBe(400);
    const binaryRow = await findBinaryRow(uploadedFile.id);
    expect(binaryRow.version).toBe(1);
    expect(binaryRow.mime_type).toBe('image/png');
    const downloadResponse = await downloadBinary(forgedAgent, uploadedFile.id);
    expect(downloadResponse.body.equals(PNG_BYTES)).toBe(true);
  });
});

describe('limites des champs multipart', () => {
  it('renvoie 400 avec trois champs texte en plus du fichier', async () => {
    const uploadResponse = await forgedAgent
      .post('/api/files')
      .attach('file', PNG_BYTES, { filename: 'logo.png', contentType: 'image/png' })
      .field('name', 'logo.png')
      .field('premierChampInconnu', 'valeur')
      .field('secondChampInconnu', 'valeur');

    expect(uploadResponse.status).toBe(400);
    expect(uploadResponse.body.error).toBe('Envoi de fichier invalide');
    expect(await countRowsCreatedByForgedUser()).toEqual({ nodeCount: 0, binaryCount: 0 });
  });

  it('renvoie 400 pour un champ texte de plus de 1024 octets', async () => {
    const uploadResponse = await forgedAgent
      .post('/api/files')
      .attach('file', PNG_BYTES, { filename: 'logo.png', contentType: 'image/png' })
      .field('champInconnu', 'a'.repeat(1025));

    expect(uploadResponse.status).toBe(400);
    expect(uploadResponse.body.error).toBe('Envoi de fichier invalide');
    expect(await countRowsCreatedByForgedUser()).toEqual({ nodeCount: 0, binaryCount: 0 });
  });
});

describe("limitation du nombre d'envois de fichiers binaires", () => {
  it('renvoie 429 après la limite pour un utilisateur sans bloquer un autre utilisateur', async () => {
    const limitedAgent = await createAuthenticatedAgent(LIMITED_EMAIL);
    const unlimitedAgent = await createAuthenticatedAgent(UNLIMITED_EMAIL);
    const uploadStatuses = [];

    for (let uploadIndex = 0; uploadIndex < BINARY_FILE_UPLOAD_LIMIT; uploadIndex += 1) {
      const uploadResponse = await uploadBinary(limitedAgent, PLAIN_TEXT_BYTES, {
        filename: `limite-${uploadIndex}.txt`,
        contentType: 'text/plain',
      });
      uploadStatuses.push(uploadResponse.status);
    }
    const exceededResponse = await uploadBinary(limitedAgent, PLAIN_TEXT_BYTES, {
      filename: 'limite-depassee.txt',
      contentType: 'text/plain',
    });
    const otherUserResponse = await uploadBinary(unlimitedAgent, PLAIN_TEXT_BYTES, {
      filename: 'autre-utilisateur.txt',
      contentType: 'text/plain',
    });

    expect(uploadStatuses.every((uploadStatus) => uploadStatus === 201)).toBe(true);
    expect(exceededResponse.status).toBe(429);
    expect(otherUserResponse.status).toBe(201);
  });
});
