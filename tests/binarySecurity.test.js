import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuthenticatedAgent, deleteTestUser } from './authHelper.js';
import { closeDatabase, resetDatabase } from './databaseHelper.js';

const OWNER_EMAIL = 'binaire-securite-proprietaire@coedit.test';

const QUOTA_BYTES = 100;
const SMALL_TEXT_BYTES = Buffer.from('a'.repeat(60));
const OVERSIZED_TEXT_BYTES = Buffer.from('a'.repeat(150));
const HTML_BYTES = Buffer.from('<script>alert(1)</script>');
const CSV_BYTES = Buffer.from('a,b\n1,2\n');

let ownerAgent;
let initialQuota;

beforeAll(async () => {
  ownerAgent = await createAuthenticatedAgent(OWNER_EMAIL);
});
beforeEach(async () => {
  await resetDatabase();
  initialQuota = process.env.USER_STORAGE_QUOTA_BYTES;
  process.env.USER_STORAGE_QUOTA_BYTES = String(QUOTA_BYTES);
});
afterEach(() => {
  if (initialQuota === undefined) {
    delete process.env.USER_STORAGE_QUOTA_BYTES;
  } else {
    process.env.USER_STORAGE_QUOTA_BYTES = initialQuota;
  }
});
afterAll(async () => {
  await deleteTestUser(OWNER_EMAIL);
  await closeDatabase();
});

async function uploadBinary(fileBytes, { filename, contentType }) {
  return ownerAgent.post('/api/files').attach('file', fileBytes, { filename, contentType });
}

describe('quota de stockage', () => {
  it("refuse en 413 un envoi qui dépasse le quota cumulé du propriétaire", async () => {
    const firstResponse = await uploadBinary(SMALL_TEXT_BYTES, { filename: 'un.txt', contentType: 'text/plain' });
    const secondResponse = await uploadBinary(SMALL_TEXT_BYTES, { filename: 'deux.txt', contentType: 'text/plain' });

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(413);
  });

  it('refuse en 413 un remplacement qui dépasse le quota', async () => {
    const uploadResponse = await uploadBinary(SMALL_TEXT_BYTES, { filename: 'un.txt', contentType: 'text/plain' });

    const replaceResponse = await ownerAgent
      .put(`/api/files/${uploadResponse.body.id}/binary`)
      .attach('file', OVERSIZED_TEXT_BYTES, { filename: 'gros.txt', contentType: 'text/plain' });

    expect(replaceResponse.status).toBe(413);
  });

  it('accepte un remplacement par un fichier de même taille', async () => {
    const uploadResponse = await uploadBinary(SMALL_TEXT_BYTES, { filename: 'un.txt', contentType: 'text/plain' });

    const replaceResponse = await ownerAgent
      .put(`/api/files/${uploadResponse.body.id}/binary`)
      .attach('file', SMALL_TEXT_BYTES, { filename: 'un.txt', contentType: 'text/plain' });

    expect(replaceResponse.status).toBe(200);
  });
});

describe('type MIME déclaré sans signature', () => {
  it('stocke application/octet-stream pour un type actif comme text/html', async () => {
    const uploadResponse = await uploadBinary(HTML_BYTES, { filename: 'page.html', contentType: 'text/html' });

    expect(uploadResponse.status).toBe(201);
    expect(uploadResponse.body.mimeType).toBe('application/octet-stream');
  });

  it('garde text/csv, type texte inoffensif', async () => {
    const uploadResponse = await uploadBinary(CSV_BYTES, { filename: 'table.csv', contentType: 'text/csv' });

    expect(uploadResponse.body.mimeType).toBe('text/csv');
  });
});
