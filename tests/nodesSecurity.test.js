import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db.js';
import { errorHandler } from '../src/middlewares/errorHandler.js';
import { MAX_FOLDER_DEPTH } from '../src/services/nodeService.js';
import { createAuthenticatedAgent, deleteTestUser } from './authHelper.js';
import { closeDatabase, resetDatabase } from './databaseHelper.js';

const OWNER_EMAIL = 'nodes-securite-proprietaire@coedit.test';
const GUEST_EMAIL = 'nodes-securite-invite@coedit.test';
const ADMIN_EMAIL = 'nodes-securite-admin@coedit.test';

let ownerAgent;
let guestAgent;
let adminAgent;
let ownerUser;

beforeAll(async () => {
  ownerAgent = await createAuthenticatedAgent(OWNER_EMAIL);
  guestAgent = await createAuthenticatedAgent(GUEST_EMAIL);
  adminAgent = await createAuthenticatedAgent(ADMIN_EMAIL, 'admin');
  ownerUser = (await ownerAgent.get('/api/auth/me')).body.user;
});
beforeEach(resetDatabase);
afterAll(async () => {
  await deleteTestUser(OWNER_EMAIL);
  await deleteTestUser(GUEST_EMAIL);
  await deleteTestUser(ADMIN_EMAIL);
  await closeDatabase();
});

async function createFolder(agent, name, parentId = null) {
  return agent.post('/api/nodes').send({ type: 'folder', name, parentId });
}

async function insertFolderChain(chainLength, ownerId) {
  let parentId = null;
  for (let level = 1; level <= chainLength; level += 1) {
    const [insertResult] = await pool.query(
      'INSERT INTO nodes (parent_id, type, name, owner_id, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)',
      [parentId, 'folder', `niveau-${level}`, ownerId, ownerId, ownerId],
    );
    parentId = insertResult.insertId;
  }
  return parentId;
}

describe('déplacements concurrents', () => {
  it("refuse l'un des deux déplacements croisés A vers B et B vers A, sans créer de cycle", async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const folderA = (await createFolder(ownerAgent, `A-${attempt}`)).body;
      const folderB = (await createFolder(ownerAgent, `B-${attempt}`)).body;

      const [moveAResponse, moveBResponse] = await Promise.all([
        ownerAgent.patch(`/api/nodes/${folderA.id}`).send({ parentId: folderB.id }),
        ownerAgent.patch(`/api/nodes/${folderB.id}`).send({ parentId: folderA.id }),
      ]);

      const successfulMoves = [moveAResponse, moveBResponse].filter((moveResponse) => moveResponse.status === 200);
      expect(successfulMoves.length).toBeLessThanOrEqual(1);
      const [folderRows] = await pool.query('SELECT id, parent_id FROM nodes WHERE id IN (?, ?)', [
        folderA.id,
        folderB.id,
      ]);
      const parentIdsByFolderId = new Map(folderRows.map((folderRow) => [folderRow.id, folderRow.parent_id]));
      const isCycle =
        parentIdsByFolderId.get(folderA.id) === folderB.id && parentIdsByFolderId.get(folderB.id) === folderA.id;
      expect(isCycle).toBe(false);
    }
  });
});

describe('profondeur maximale', () => {
  it('refuse la création au-delà de la profondeur maximale', async () => {
    const deepestFolderId = await insertFolderChain(MAX_FOLDER_DEPTH, ownerUser.id);

    const creationResponse = await createFolder(ownerAgent, 'trop-profond', deepestFolderId);

    expect(creationResponse.status).toBe(400);
  });

  it('accepte la création au dernier niveau autorisé', async () => {
    const parentFolderId = await insertFolderChain(MAX_FOLDER_DEPTH - 1, ownerUser.id);

    const creationResponse = await createFolder(ownerAgent, 'dernier-niveau', parentFolderId);

    expect(creationResponse.status).toBe(201);
  });

  it('refuse un déplacement dont le sous-arbre dépasserait la profondeur maximale', async () => {
    const deepestFolderId = await insertFolderChain(MAX_FOLDER_DEPTH - 1, ownerUser.id);
    const movedFolder = (await createFolder(ownerAgent, 'deplace')).body;
    await createFolder(ownerAgent, 'enfant-deplace', movedFolder.id);

    const moveResponse = await ownerAgent.patch(`/api/nodes/${movedFolder.id}`).send({ parentId: deepestFolderId });

    expect(moveResponse.status).toBe(400);
  });
});

describe('validation des noms', () => {
  it.each([
    ['un caractère nul', 'a\u0000b'],
    ['une tabulation', 'a\tb'],
    ['un saut de ligne interne', 'a\nb'],
    ['un caractère de suppression', 'a\u007Fb'],
    ['un forçage de sens bidirectionnel', 'document‮fdp.exe'],
    ['un isolat bidirectionnel', 'a⁦b'],
    ['une marque de sens gauche-droite', 'a‎b'],
    ['le nom point', '.'],
    ['le nom double point', '..'],
  ])('refuse un nom contenant %s', async (description, forbiddenName) => {
    const creationResponse = await createFolder(ownerAgent, forbiddenName);

    expect(creationResponse.status).toBe(400);
  });

  it('refuse aussi ces noms au renommage', async () => {
    const folder = (await createFolder(ownerAgent, 'dossier')).body;

    const renameResponse = await ownerAgent.patch(`/api/nodes/${folder.id}`).send({ name: '..' });

    expect(renameResponse.status).toBe(400);
  });
});

describe('clé étrangère manquante', () => {
  it('répond 404 au lieu de 500 sur ER_NO_REFERENCED_ROW_2', () => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    errorHandler({ code: 'ER_NO_REFERENCED_ROW_2' }, {}, response, () => {});

    expect(response.status).toHaveBeenCalledWith(404);
  });
});

describe('parentId exposé à un invité', () => {
  it("renvoie parentId null sur la racine d'un partage", async () => {
    const privateFolder = (await createFolder(ownerAgent, 'prive')).body;
    const sharedFolder = (await createFolder(ownerAgent, 'partage', privateFolder.id)).body;
    await ownerAgent.post(`/api/folders/${sharedFolder.id}/shares`).send({ email: GUEST_EMAIL, permission: 'read' });

    const nodeResponse = await guestAgent.get(`/api/nodes/${sharedFolder.id}`);

    expect(nodeResponse.status).toBe(200);
    expect(nodeResponse.body.parentId).toBeNull();
  });

  it('garde parentId pour un sous-dossier du partage', async () => {
    const sharedFolder = (await createFolder(ownerAgent, 'partage')).body;
    const childFolder = (await createFolder(ownerAgent, 'enfant', sharedFolder.id)).body;
    await ownerAgent.post(`/api/folders/${sharedFolder.id}/shares`).send({ email: GUEST_EMAIL, permission: 'read' });

    const nodeResponse = await guestAgent.get(`/api/nodes/${childFolder.id}`);

    expect(nodeResponse.body.parentId).toBe(sharedFolder.id);
  });
});

describe("déplacement à la racine par un administrateur", () => {
  it("replace l'élément à la racine de son propriétaire", async () => {
    const parentFolder = (await createFolder(ownerAgent, 'parent')).body;
    const movedFolder = (await createFolder(ownerAgent, 'enfant', parentFolder.id)).body;

    const moveResponse = await adminAgent.patch(`/api/nodes/${movedFolder.id}`).send({ parentId: null });

    expect(moveResponse.status).toBe(200);
    expect(moveResponse.body.parentId).toBeNull();
    expect(moveResponse.body.ownerId).toBe(ownerUser.id);
    const ownerRootListing = await ownerAgent.get('/api/folders/root/children');
    expect(ownerRootListing.body.children.map((child) => child.id)).toContain(movedFolder.id);
  });
});
