import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { createAuthenticatedAgent, deleteTestUser } from './authHelper.js';
import { closeDatabase, resetDatabase } from './databaseHelper.js';

const NODES_TEST_EMAIL = 'nodes@coedit.test';
const FORMER_AUTHOR_EMAIL = 'ancien-auteur@coedit.test';
let authenticatedAgent;

beforeAll(async () => {
  authenticatedAgent = await createAuthenticatedAgent(NODES_TEST_EMAIL);
});
beforeEach(resetDatabase);
afterAll(async () => {
  await deleteTestUser(NODES_TEST_EMAIL);
  await closeDatabase();
});

describe('authentification requise', () => {
  it.each([
    ['GET', '/api/folders/root/children'],
    ['POST', '/api/nodes'],
    ['GET', '/api/nodes/1'],
    ['GET', '/api/files/1/content'],
  ])('%s %s renvoie 401 sans session', async (method, path) => {
    const anonymousResponse = await request(app)[method.toLowerCase()](path).send({ type: 'folder', name: 'poc' });
    expect(anonymousResponse.status).toBe(401);
  });
});

async function createFolder(name, parentId = null) {
  return authenticatedAgent.post('/api/nodes').send({ type: 'folder', name, parentId });
}

async function createFile(name, parentId = null, content = '') {
  return authenticatedAgent.post('/api/nodes').send({ type: 'file', name, parentId, content });
}

describe('GET /api/folders/root/children', () => {
  it("renvoie une racine vide quand aucun nœud n'existe", async () => {
    const rootListingResponse = await authenticatedAgent.get('/api/folders/root/children');

    expect(rootListingResponse.status).toBe(200);
    expect(rootListingResponse.body.folder).toBeNull();
    expect(rootListingResponse.body.breadcrumb).toEqual([]);
    expect(rootListingResponse.body.children).toEqual([]);
  });
});

describe('GET /api/folders/:folderId/children', () => {
  it('liste les dossiers avant les fichiers, chacun trié par nom', async () => {
    const parentFolder = (await createFolder('Parent')).body;
    await createFolder('Zebra', parentFolder.id);
    await createFolder('Alpha', parentFolder.id);
    await createFile('banana.txt', parentFolder.id, 'banana');
    await createFile('apple.txt', parentFolder.id, 'apple');

    const listingResponse = await authenticatedAgent.get(`/api/folders/${parentFolder.id}/children`);

    expect(listingResponse.status).toBe(200);
    const childNames = listingResponse.body.children.map((childNode) => childNode.name);
    expect(childNames).toEqual(['Alpha', 'Zebra', 'apple.txt', 'banana.txt']);
  });

  it('renvoie childrenCount pour un dossier et size pour un fichier, en comptant les accents', async () => {
    const parentFolder = (await createFolder('Parent')).body;
    await createFolder('SousDossier', parentFolder.id);
    await createFile('été', parentFolder.id, 'été');

    const listingResponse = await authenticatedAgent.get(`/api/folders/${parentFolder.id}/children`);

    const folderChild = listingResponse.body.children.find((childNode) => childNode.name === 'SousDossier');
    const fileChild = listingResponse.body.children.find((childNode) => childNode.name === 'été');
    expect(folderChild.childrenCount).toBe(0);
    expect(fileChild.size).toBe(3);
  });

  it('renvoie le breadcrumb racine→dossier sur 3 niveaux', async () => {
    const levelOneFolder = (await createFolder('NiveauUn')).body;
    const levelTwoFolder = (await createFolder('NiveauDeux', levelOneFolder.id)).body;
    const levelThreeFolder = (await createFolder('NiveauTrois', levelTwoFolder.id)).body;

    const listingResponse = await authenticatedAgent.get(`/api/folders/${levelThreeFolder.id}/children`);

    expect(listingResponse.body.breadcrumb).toEqual([
      { id: levelOneFolder.id, name: 'NiveauUn' },
      { id: levelTwoFolder.id, name: 'NiveauDeux' },
      { id: levelThreeFolder.id, name: 'NiveauTrois' },
    ]);
  });

  it("renvoie 400 quand l'identifiant désigne un fichier", async () => {
    const createdFile = (await createFile('fichier.txt', null, 'contenu')).body;

    const listingResponse = await authenticatedAgent.get(`/api/folders/${createdFile.id}/children`);

    expect(listingResponse.status).toBe(400);
    expect(listingResponse.body.error).toBeDefined();
  });

  it("renvoie 404 quand l'identifiant n'existe pas", async () => {
    const listingResponse = await authenticatedAgent.get('/api/folders/999999/children');

    expect(listingResponse.status).toBe(404);
    expect(listingResponse.body.error).toBeDefined();
  });

  it("renvoie 400 quand l'identifiant n'est pas numérique", async () => {
    const listingResponse = await authenticatedAgent.get('/api/folders/abc/children');

    expect(listingResponse.status).toBe(400);
    expect(listingResponse.body.error).toBeDefined();
  });
});

describe('POST /api/nodes', () => {
  it('crée un dossier et renvoie 201', async () => {
    const creationResponse = await createFolder('MonDossier');

    expect(creationResponse.status).toBe(201);
    expect(creationResponse.body.type).toBe('folder');
    expect(creationResponse.body.name).toBe('MonDossier');
    expect(creationResponse.body.parentId).toBeNull();
  });

  it("enregistre l'utilisateur connecté comme auteur de l'élément", async () => {
    const currentUser = (await authenticatedAgent.get('/api/auth/me')).body.user;

    const creationResponse = await createFile('Auteur.txt');
    const nodeResponse = await authenticatedAgent.get(`/api/nodes/${creationResponse.body.id}`);

    expect(creationResponse.body.ownerId).toBe(currentUser.id);
    expect(nodeResponse.body.ownerId).toBe(currentUser.id);
  });

  it("conserve l'élément sans auteur quand le compte de l'auteur est supprimé", async () => {
    const formerAuthorAgent = await createAuthenticatedAgent(FORMER_AUTHOR_EMAIL);
    const createdFolder = (await formerAuthorAgent.post('/api/nodes').send({ type: 'folder', name: 'Orphelin' })).body;

    await deleteTestUser(FORMER_AUTHOR_EMAIL);
    const nodeResponse = await authenticatedAgent.get(`/api/nodes/${createdFolder.id}`);

    expect(nodeResponse.status).toBe(200);
    expect(nodeResponse.body.ownerId).toBeNull();
  });

  it('crée un fichier et renvoie 201', async () => {
    const creationResponse = await createFile('MonFichier.txt', null, 'bonjour');

    expect(creationResponse.status).toBe(201);
    expect(creationResponse.body.type).toBe('file');
    expect(creationResponse.body.name).toBe('MonFichier.txt');
  });

  it('trime le nom fourni', async () => {
    const creationResponse = await createFolder('  DossierAvecEspaces  ');

    expect(creationResponse.status).toBe(201);
    expect(creationResponse.body.name).toBe('DossierAvecEspaces');
  });

  it('renvoie 400 pour un nom vide', async () => {
    const creationResponse = await createFolder('   ');

    expect(creationResponse.status).toBe(400);
    expect(creationResponse.body.error).toBeDefined();
  });

  it('renvoie 400 pour un nom contenant un slash', async () => {
    const creationResponse = await createFolder('dossier/invalide');

    expect(creationResponse.status).toBe(400);
    expect(creationResponse.body.error).toBeDefined();
  });

  it('renvoie 400 pour un type invalide', async () => {
    const creationResponse = await authenticatedAgent
      .post('/api/nodes')
      .send({ type: 'archive', name: 'Test', parentId: null });

    expect(creationResponse.status).toBe(400);
    expect(creationResponse.body.error).toBeDefined();
  });

  it('renvoie 400 quand le dossier parent est introuvable', async () => {
    const creationResponse = await createFolder('Enfant', 999999);

    expect(creationResponse.status).toBe(400);
    expect(creationResponse.body.error).toBeDefined();
  });

  it("renvoie 400 quand le parent désigné est un fichier", async () => {
    const parentFile = (await createFile('parent.txt', null, 'contenu')).body;

    const creationResponse = await createFolder('Enfant', parentFile.id);

    expect(creationResponse.status).toBe(400);
    expect(creationResponse.body.error).toBeDefined();
  });

  it('renvoie 409 pour un homonyme dans le même dossier', async () => {
    const parentFolder = (await createFolder('Parent')).body;
    await createFolder('Doublon', parentFolder.id);

    const conflictResponse = await createFolder('Doublon', parentFolder.id);

    expect(conflictResponse.status).toBe(409);
    expect(conflictResponse.body.error).toBeDefined();
  });

  it('renvoie 409 pour un homonyme à la racine', async () => {
    await createFolder('DoublonRacine');

    const conflictResponse = await createFolder('DoublonRacine');

    expect(conflictResponse.status).toBe(409);
    expect(conflictResponse.body.error).toBeDefined();
  });

  it('accepte le même nom dans deux dossiers différents', async () => {
    const firstParentFolder = (await createFolder('ParentA')).body;
    const secondParentFolder = (await createFolder('ParentB')).body;
    await createFolder('MemeNom', firstParentFolder.id);

    const secondCreationResponse = await createFolder('MemeNom', secondParentFolder.id);

    expect(secondCreationResponse.status).toBe(201);
  });

  it('renvoie 409 pour « Notes » vs « notes » (collation insensible à la casse)', async () => {
    await createFolder('Notes');

    const conflictResponse = await createFolder('notes');

    expect(conflictResponse.status).toBe(409);
    expect(conflictResponse.body.error).toBeDefined();
  });
});

describe('GET /api/nodes/:nodeId', () => {
  it("renvoie les métadonnées d'un nœud", async () => {
    const createdFolder = (await createFolder('DossierMeta')).body;

    const nodeResponse = await authenticatedAgent.get(`/api/nodes/${createdFolder.id}`);

    expect(nodeResponse.status).toBe(200);
    expect(nodeResponse.body).toMatchObject({
      id: createdFolder.id,
      name: 'DossierMeta',
      type: 'folder',
      parentId: null,
    });
  });

  it("renvoie 404 quand le nœud n'existe pas", async () => {
    const nodeResponse = await authenticatedAgent.get('/api/nodes/999999');

    expect(nodeResponse.status).toBe(404);
    expect(nodeResponse.body.error).toBeDefined();
  });
});

describe('PATCH /api/nodes/:nodeId', () => {
  it('renomme un nœud', async () => {
    const createdFolder = (await createFolder('AncienNom')).body;

    const renameResponse = await authenticatedAgent
      .patch(`/api/nodes/${createdFolder.id}`)
      .send({ name: 'NouveauNom' });

    expect(renameResponse.status).toBe(200);
    expect(renameResponse.body.name).toBe('NouveauNom');
  });

  it('déplace un nœud vers un autre dossier', async () => {
    const sourceFolder = (await createFolder('Source')).body;
    const destinationFolder = (await createFolder('Destination')).body;
    const fileToMove = (await createFile('fichier.txt', sourceFolder.id, 'contenu')).body;

    const moveResponse = await authenticatedAgent
      .patch(`/api/nodes/${fileToMove.id}`)
      .send({ parentId: destinationFolder.id });

    expect(moveResponse.status).toBe(200);
    expect(moveResponse.body.parentId).toBe(destinationFolder.id);
  });

  it('déplace un nœud vers la racine', async () => {
    const parentFolder = (await createFolder('Parent')).body;
    const childFolder = (await createFolder('Enfant', parentFolder.id)).body;

    const moveResponse = await authenticatedAgent
      .patch(`/api/nodes/${childFolder.id}`)
      .send({ parentId: null });

    expect(moveResponse.status).toBe(200);
    expect(moveResponse.body.parentId).toBeNull();
  });

  it('renvoie 400 quand on déplace un dossier dans lui-même', async () => {
    const folderToMove = (await createFolder('Recursif')).body;

    const moveResponse = await authenticatedAgent
      .patch(`/api/nodes/${folderToMove.id}`)
      .send({ parentId: folderToMove.id });

    expect(moveResponse.status).toBe(400);
    expect(moveResponse.body.error).toBeDefined();
  });

  it('renvoie 400 quand on déplace un dossier dans un de ses descendants', async () => {
    const ancestorFolder = (await createFolder('Ancetre')).body;
    const childFolder = (await createFolder('Enfant', ancestorFolder.id)).body;
    const grandchildFolder = (await createFolder('PetitEnfant', childFolder.id)).body;

    const moveResponse = await authenticatedAgent
      .patch(`/api/nodes/${ancestorFolder.id}`)
      .send({ parentId: grandchildFolder.id });

    expect(moveResponse.status).toBe(400);
    expect(moveResponse.body.error).toBeDefined();
  });

  it('renvoie 400 pour un corps vide', async () => {
    const createdFolder = (await createFolder('Dossier')).body;

    const patchResponse = await authenticatedAgent.patch(`/api/nodes/${createdFolder.id}`).send({});

    expect(patchResponse.status).toBe(400);
    expect(patchResponse.body.error).toBeDefined();
  });

  it('renvoie 409 quand on renomme en homonyme', async () => {
    const parentFolder = (await createFolder('Parent')).body;
    await createFolder('Existant', parentFolder.id);
    const folderToRename = (await createFolder('ARenommer', parentFolder.id)).body;

    const renameResponse = await authenticatedAgent
      .patch(`/api/nodes/${folderToRename.id}`)
      .send({ name: 'Existant' });

    expect(renameResponse.status).toBe(409);
    expect(renameResponse.body.error).toBeDefined();
  });
});

describe('DELETE /api/nodes/:nodeId', () => {
  it('supprime un dossier et fait disparaître ses descendants', async () => {
    const topFolder = (await createFolder('ADetruire')).body;
    const subFolder = (await createFolder('SousDossier', topFolder.id)).body;
    const fileInSubFolder = (await createFile('fichier.txt', subFolder.id, 'contenu')).body;

    const deleteResponse = await authenticatedAgent.delete(`/api/nodes/${topFolder.id}`);
    expect(deleteResponse.status).toBe(204);

    const subFolderResponse = await authenticatedAgent.get(`/api/nodes/${subFolder.id}`);
    const fileResponse = await authenticatedAgent.get(`/api/nodes/${fileInSubFolder.id}`);
    expect(subFolderResponse.status).toBe(404);
    expect(fileResponse.status).toBe(404);
  });

  it("renvoie 404 quand le nœud à supprimer n'existe pas", async () => {
    const deleteResponse = await authenticatedAgent.delete('/api/nodes/999999');

    expect(deleteResponse.status).toBe(404);
    expect(deleteResponse.body.error).toBeDefined();
  });

  it('supprime un arbre profond de 20 niveaux malgré la limite de cascade InnoDB', async () => {
    const nestedFolderIds = [];
    let currentParentId = null;
    for (let depthLevel = 1; depthLevel <= 20; depthLevel += 1) {
      const nestedFolder = (await createFolder(`Niveau${depthLevel}`, currentParentId)).body;
      nestedFolderIds.push(nestedFolder.id);
      currentParentId = nestedFolder.id;
    }

    const deleteResponse = await authenticatedAgent.delete(`/api/nodes/${nestedFolderIds[0]}`);
    expect(deleteResponse.status).toBe(204);

    for (const nestedFolderId of nestedFolderIds) {
      const nestedFolderResponse = await authenticatedAgent.get(`/api/nodes/${nestedFolderId}`);
      expect(nestedFolderResponse.status).toBe(404);
    }
  });
});

describe('GET /api/files/:fileId/content', () => {
  it('renvoie le contenu et la version 1 pour un fichier fraîchement créé', async () => {
    const createdFile = (await createFile('document.txt', null, 'contenu initial')).body;

    const contentResponse = await authenticatedAgent.get(`/api/files/${createdFile.id}/content`);

    expect(contentResponse.status).toBe(200);
    expect(contentResponse.body.content).toBe('contenu initial');
    expect(contentResponse.body.version).toBe(1);
  });

  it("renvoie 400 pour le contenu d'un dossier", async () => {
    const createdFolder = (await createFolder('Dossier')).body;

    const contentResponse = await authenticatedAgent.get(`/api/files/${createdFolder.id}/content`);

    expect(contentResponse.status).toBe(400);
    expect(contentResponse.body.error).toBeDefined();
  });
});

describe('PUT /api/files/:fileId/content', () => {
  it("renvoie 404, la route ayant été remplacée par l'édition temps réel", async () => {
    const createdFile = (await createFile('document.txt', null, 'contenu initial')).body;

    const saveResponse = await authenticatedAgent
      .put(`/api/files/${createdFile.id}/content`)
      .send({ content: 'contenu modifié', version: 1 });

    expect(saveResponse.status).toBe(404);
  });
});
