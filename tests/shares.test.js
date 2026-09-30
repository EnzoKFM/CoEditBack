import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuthenticatedAgent, deleteTestUser } from './authHelper.js';
import { closeDatabase, resetDatabase } from './databaseHelper.js';
import { pool } from '../src/db.js';

const OWNER_EMAIL = 'partage-proprietaire@coedit.test';
const GUEST_EMAIL = 'partage-invite@coedit.test';
const STRANGER_EMAIL = 'partage-etranger@coedit.test';
const UNKNOWN_EMAIL = 'partage-inconnu@coedit.test';
const ADMIN_EMAIL = 'partage-admin@coedit.test';
const FORMER_AUTHOR_EMAIL = 'partage-ancien-auteur@coedit.test';

let ownerAgent;
let guestAgent;
let strangerAgent;
let adminAgent;
let ownerUser;
let guestUser;
let adminUser;

beforeAll(async () => {
  ownerAgent = await createAuthenticatedAgent(OWNER_EMAIL);
  guestAgent = await createAuthenticatedAgent(GUEST_EMAIL);
  strangerAgent = await createAuthenticatedAgent(STRANGER_EMAIL);
  adminAgent = await createAuthenticatedAgent(ADMIN_EMAIL, 'admin');
  ownerUser = (await ownerAgent.get('/api/auth/me')).body.user;
  guestUser = (await guestAgent.get('/api/auth/me')).body.user;
  adminUser = (await adminAgent.get('/api/auth/me')).body.user;
});
beforeEach(resetDatabase);
afterAll(async () => {
  await deleteTestUser(OWNER_EMAIL);
  await deleteTestUser(GUEST_EMAIL);
  await deleteTestUser(STRANGER_EMAIL);
  await deleteTestUser(ADMIN_EMAIL);
  await deleteTestUser(FORMER_AUTHOR_EMAIL);
  await closeDatabase();
});

async function createFolder(agent, name, parentId = null) {
  return agent.post('/api/nodes').send({ type: 'folder', name, parentId });
}

async function createFile(agent, name, parentId = null, content = '') {
  return agent.post('/api/nodes').send({ type: 'file', name, parentId, content });
}

async function shareFolder(folderId, email, permission) {
  return ownerAgent.post(`/api/folders/${folderId}/shares`).send({ email, permission });
}

async function createSharedFolder(permission) {
  const sharedFolder = (await createFolder(ownerAgent, 'Partagé')).body;
  await shareFolder(sharedFolder.id, GUEST_EMAIL, permission);
  return sharedFolder;
}

describe('isolation entre utilisateurs', () => {
  it("renvoie 404 à un autre utilisateur qui lit l'élément", async () => {
    const privateFolder = (await createFolder(ownerAgent, 'Privé')).body;

    const readResponse = await strangerAgent.get(`/api/nodes/${privateFolder.id}`);

    expect(readResponse.status).toBe(404);
    expect(readResponse.body.error).toBe('Élément introuvable');
  });

  it('ne liste à la racine que les nœuds de son propriétaire', async () => {
    await createFolder(ownerAgent, 'DossierProprietaire');
    await createFolder(strangerAgent, 'DossierEtranger');

    const ownerListing = await ownerAgent.get('/api/folders/root/children');
    const strangerListing = await strangerAgent.get('/api/folders/root/children');

    expect(ownerListing.body.children.map((child) => child.name)).toEqual(['DossierProprietaire']);
    expect(strangerListing.body.children.map((child) => child.name)).toEqual(['DossierEtranger']);
  });

  it("renvoie 404 pour lister les enfants du dossier d'un autre utilisateur", async () => {
    const privateFolder = (await createFolder(ownerAgent, 'Privé')).body;

    const listingResponse = await strangerAgent.get(`/api/folders/${privateFolder.id}/children`);

    expect(listingResponse.status).toBe(404);
  });

  it("renvoie 404 pour lire le contenu d'un fichier d'un autre utilisateur", async () => {
    const privateFile = (await createFile(ownerAgent, 'secret.txt', null, 'secret')).body;

    const contentResponse = await strangerAgent.get(`/api/files/${privateFile.id}/content`);

    expect(contentResponse.status).toBe(404);
  });

  it("renvoie 404 pour renommer l'élément d'un autre utilisateur", async () => {
    const privateFolder = (await createFolder(ownerAgent, 'Privé')).body;

    const renameResponse = await strangerAgent.patch(`/api/nodes/${privateFolder.id}`).send({ name: 'Volé' });
    const ownerNodeResponse = await ownerAgent.get(`/api/nodes/${privateFolder.id}`);

    expect(renameResponse.status).toBe(404);
    expect(ownerNodeResponse.body.name).toBe('Privé');
  });

  it("renvoie 404 pour supprimer l'élément d'un autre utilisateur", async () => {
    const privateFolder = (await createFolder(ownerAgent, 'Privé')).body;

    const deletionResponse = await strangerAgent.delete(`/api/nodes/${privateFolder.id}`);
    const ownerNodeResponse = await ownerAgent.get(`/api/nodes/${privateFolder.id}`);

    expect(deletionResponse.status).toBe(404);
    expect(ownerNodeResponse.status).toBe(200);
  });

  it("renvoie 400 pour créer dans le dossier d'un autre utilisateur", async () => {
    const privateFolder = (await createFolder(ownerAgent, 'Privé')).body;

    const creationResponse = await createFile(strangerAgent, 'intrus.txt', privateFolder.id);

    expect(creationResponse.status).toBe(400);
  });

  it('autorise le même nom à la racine pour deux utilisateurs', async () => {
    const ownerCreation = await createFolder(ownerAgent, 'Documents');
    const strangerCreation = await createFolder(strangerAgent, 'Documents');
    const duplicateCreation = await createFolder(ownerAgent, 'Documents');

    expect(ownerCreation.status).toBe(201);
    expect(strangerCreation.status).toBe(201);
    expect(duplicateCreation.status).toBe(409);
  });
});

describe('permission read', () => {
  it("permet de lire le dossier, son contenu et renvoie la permission", async () => {
    const sharedFolder = await createSharedFolder('read');
    const sharedFile = (await createFile(ownerAgent, 'lisez-moi.txt', sharedFolder.id, 'bonjour')).body;

    const nodeResponse = await guestAgent.get(`/api/nodes/${sharedFolder.id}`);
    const listingResponse = await guestAgent.get(`/api/folders/${sharedFolder.id}/children`);
    const contentResponse = await guestAgent.get(`/api/files/${sharedFile.id}/content`);

    expect(nodeResponse.status).toBe(200);
    expect(nodeResponse.body.permission).toBe('read');
    expect(listingResponse.body.folder.permission).toBe('read');
    expect(listingResponse.body.children.map((child) => child.name)).toEqual(['lisez-moi.txt']);
    expect(contentResponse.body.content).toBe('bonjour');
  });

  it('renvoie la permission owner au propriétaire', async () => {
    const sharedFolder = await createSharedFolder('read');

    const nodeResponse = await ownerAgent.get(`/api/nodes/${sharedFolder.id}`);

    expect(nodeResponse.body.permission).toBe('owner');
  });

  it('renvoie 403 pour créer, renommer et supprimer', async () => {
    const sharedFolder = await createSharedFolder('read');
    const sharedFile = (await createFile(ownerAgent, 'lisez-moi.txt', sharedFolder.id)).body;

    const creationResponse = await createFile(guestAgent, 'nouveau.txt', sharedFolder.id);
    const renameResponse = await guestAgent.patch(`/api/nodes/${sharedFile.id}`).send({ name: 'renomme.txt' });
    const deletionResponse = await guestAgent.delete(`/api/nodes/${sharedFile.id}`);

    expect(creationResponse.status).toBe(403);
    expect(renameResponse.status).toBe(403);
    expect(deletionResponse.status).toBe(403);
  });
});

describe('permission write', () => {
  it('permet de créer et renommer mais pas de supprimer ni déplacer', async () => {
    const sharedFolder = await createSharedFolder('write');
    const targetFolder = (await createFolder(ownerAgent, 'Cible', sharedFolder.id)).body;

    const creationResponse = await createFile(guestAgent, 'nouveau.txt', sharedFolder.id);
    const renameResponse = await guestAgent.patch(`/api/nodes/${creationResponse.body.id}`).send({ name: 'renomme.txt' });
    const moveResponse = await guestAgent
      .patch(`/api/nodes/${creationResponse.body.id}`)
      .send({ parentId: targetFolder.id });
    const deletionResponse = await guestAgent.delete(`/api/nodes/${creationResponse.body.id}`);

    expect(creationResponse.status).toBe(201);
    expect(renameResponse.status).toBe(200);
    expect(renameResponse.body.name).toBe('renomme.txt');
    expect(moveResponse.status).toBe(403);
    expect(deletionResponse.status).toBe(403);
  });

  it("retient le créateur et l'invité qui a modifié en dernier", async () => {
    const sharedFolder = await createSharedFolder('write');
    const ownerFile = (await createFile(ownerAgent, 'rapport.txt', sharedFolder.id)).body;

    const renameResponse = await guestAgent.patch(`/api/nodes/${ownerFile.id}`).send({ name: 'rapport-v2.txt' });
    const listingResponse = await ownerAgent.get(`/api/folders/${sharedFolder.id}/children`);
    const listedFile = listingResponse.body.children.find((child) => child.id === ownerFile.id);

    const ownerAuthor = { id: ownerUser.id, name: `${ownerUser.firstName} ${ownerUser.lastName}` };
    const guestAuthor = { id: guestUser.id, name: `${guestUser.firstName} ${guestUser.lastName}` };
    expect(renameResponse.body.createdBy).toEqual(ownerAuthor);
    expect(renameResponse.body.updatedBy).toEqual(guestAuthor);
    expect(listedFile.createdBy).toEqual(ownerAuthor);
    expect(listedFile.updatedBy).toEqual(guestAuthor);
  });

  it("donne au propriétaire l'élément créé par l'invité", async () => {
    const sharedFolder = await createSharedFolder('write');

    const guestCreation = await createFile(guestAgent, 'invite.txt', sharedFolder.id);
    const subfolderCreation = await createFolder(guestAgent, 'SousDossier', sharedFolder.id);

    expect(guestCreation.status).toBe(201);
    expect(guestCreation.body.ownerId).toBe(ownerUser.id);
    expect(subfolderCreation.body.ownerId).toBe(ownerUser.id);
  });

  it("rend l'élément créé par l'invité visible du propriétaire", async () => {
    const sharedFolder = await createSharedFolder('write');
    const guestFile = (await createFile(guestAgent, 'invite.txt', sharedFolder.id)).body;

    const ownerNodeResponse = await ownerAgent.get(`/api/nodes/${guestFile.id}`);

    expect(ownerNodeResponse.status).toBe(200);
    expect(ownerNodeResponse.body.permission).toBe('owner');
  });
});

describe('permission delete', () => {
  it('permet de supprimer un contenu du dossier partagé', async () => {
    const sharedFolder = await createSharedFolder('delete');
    const sharedFile = (await createFile(ownerAgent, 'jetable.txt', sharedFolder.id)).body;

    const deletionResponse = await guestAgent.delete(`/api/nodes/${sharedFile.id}`);
    const ownerNodeResponse = await ownerAgent.get(`/api/nodes/${sharedFile.id}`);

    expect(deletionResponse.status).toBe(204);
    expect(ownerNodeResponse.status).toBe(404);
  });

  it('permet de déplacer un élément dans le même espace partagé', async () => {
    const sharedFolder = await createSharedFolder('delete');
    const targetFolder = (await createFolder(ownerAgent, 'Cible', sharedFolder.id)).body;
    const sharedFile = (await createFile(ownerAgent, 'deplace.txt', sharedFolder.id)).body;

    const moveResponse = await guestAgent.patch(`/api/nodes/${sharedFile.id}`).send({ parentId: targetFolder.id });

    expect(moveResponse.status).toBe(200);
    expect(moveResponse.body.parentId).toBe(targetFolder.id);
  });

  it("refuse de déplacer un élément vers sa propre racine", async () => {
    const sharedFolder = await createSharedFolder('delete');
    const sharedFile = (await createFile(ownerAgent, 'reste.txt', sharedFolder.id)).body;

    const moveResponse = await guestAgent.patch(`/api/nodes/${sharedFile.id}`).send({ parentId: null });
    const ownerNodeResponse = await ownerAgent.get(`/api/nodes/${sharedFile.id}`);

    expect(moveResponse.status).toBe(400);
    expect(ownerNodeResponse.body.parentId).toBe(sharedFolder.id);
  });

  it("refuse de déplacer un élément vers le dossier d'un autre propriétaire", async () => {
    const sharedFolder = await createSharedFolder('delete');
    const sharedFile = (await createFile(ownerAgent, 'reste.txt', sharedFolder.id)).body;
    const guestOwnFolder = (await createFolder(guestAgent, 'MonDossier')).body;

    const moveResponse = await guestAgent.patch(`/api/nodes/${sharedFile.id}`).send({ parentId: guestOwnFolder.id });

    expect(moveResponse.status).toBe(400);
  });
});

describe('dossier partagé lui-même', () => {
  it.each(['read', 'write', 'delete'])(
    "ne peut être ni renommé ni supprimé ni déplacé par un invité %s",
    async (permission) => {
      const sharedFolder = await createSharedFolder(permission);

      const renameResponse = await guestAgent.patch(`/api/nodes/${sharedFolder.id}`).send({ name: 'Renommé' });
      const moveResponse = await guestAgent.patch(`/api/nodes/${sharedFolder.id}`).send({ parentId: null });
      const deletionResponse = await guestAgent.delete(`/api/nodes/${sharedFolder.id}`);
      const ownerNodeResponse = await ownerAgent.get(`/api/nodes/${sharedFolder.id}`);

      expect(renameResponse.status).toBe(403);
      expect(moveResponse.status).toBe(403);
      expect(deletionResponse.status).toBe(403);
      expect(ownerNodeResponse.body.name).toBe('Partagé');
    },
  );
});

describe('héritage du droit', () => {
  it('applique le droit du dossier partagé sur ses descendants', async () => {
    const sharedFolder = await createSharedFolder('write');
    const subfolder = (await createFolder(ownerAgent, 'Sous', sharedFolder.id)).body;
    const deepFolder = (await createFolder(ownerAgent, 'Profond', subfolder.id)).body;
    const deepFile = (await createFile(ownerAgent, 'profond.txt', deepFolder.id, 'abc')).body;

    const deepNodeResponse = await guestAgent.get(`/api/nodes/${deepFile.id}`);
    const contentResponse = await guestAgent.get(`/api/files/${deepFile.id}/content`);
    const creationResponse = await createFile(guestAgent, 'invite.txt', deepFolder.id);
    const deletionResponse = await guestAgent.delete(`/api/nodes/${deepFile.id}`);

    expect(deepNodeResponse.body.permission).toBe('write');
    expect(contentResponse.body.content).toBe('abc');
    expect(creationResponse.status).toBe(201);
    expect(deletionResponse.status).toBe(403);
  });

  it('retient le droit le plus élevé quand plusieurs partages sont sur la chaîne', async () => {
    const sharedFolder = await createSharedFolder('read');
    const subfolder = (await createFolder(ownerAgent, 'Sous', sharedFolder.id)).body;
    const subfile = (await createFile(ownerAgent, 'sous.txt', subfolder.id)).body;
    await shareFolder(subfolder.id, GUEST_EMAIL, 'delete');

    const subfolderResponse = await guestAgent.get(`/api/nodes/${subfolder.id}`);
    const deletionResponse = await guestAgent.delete(`/api/nodes/${subfile.id}`);
    const sharedFolderResponse = await guestAgent.get(`/api/nodes/${sharedFolder.id}`);

    expect(subfolderResponse.body.permission).toBe('delete');
    expect(deletionResponse.status).toBe(204);
    expect(sharedFolderResponse.body.permission).toBe('read');
  });

  it("n'expose pas les dossiers voisins non partagés", async () => {
    await createSharedFolder('read');
    const siblingFolder = (await createFolder(ownerAgent, 'Voisin')).body;

    const siblingResponse = await guestAgent.get(`/api/nodes/${siblingFolder.id}`);
    const guestRootListing = await guestAgent.get('/api/folders/root/children');

    expect(siblingResponse.status).toBe(404);
    expect(guestRootListing.body.children).toEqual([]);
  });
});

describe('breadcrumb pour un invité', () => {
  it('commence au dossier partagé et masque le parent du propriétaire', async () => {
    const ownerParent = (await createFolder(ownerAgent, 'Parent')).body;
    const sharedFolder = (await createFolder(ownerAgent, 'Partagé', ownerParent.id)).body;
    const subfolder = (await createFolder(ownerAgent, 'Sous', sharedFolder.id)).body;
    await shareFolder(sharedFolder.id, GUEST_EMAIL, 'read');

    const sharedListing = await guestAgent.get(`/api/folders/${sharedFolder.id}/children`);
    const subfolderListing = await guestAgent.get(`/api/folders/${subfolder.id}/children`);
    const ownerListing = await ownerAgent.get(`/api/folders/${sharedFolder.id}/children`);

    expect(sharedListing.body.folder.parentId).toBeNull();
    expect(sharedListing.body.breadcrumb.map((ancestor) => ancestor.name)).toEqual(['Partagé']);
    expect(subfolderListing.body.folder.parentId).toBe(sharedFolder.id);
    expect(subfolderListing.body.breadcrumb.map((ancestor) => ancestor.name)).toEqual(['Partagé', 'Sous']);
    expect(ownerListing.body.folder.parentId).toBe(ownerParent.id);
    expect(ownerListing.body.breadcrumb.map((ancestor) => ancestor.name)).toEqual(['Parent', 'Partagé']);
  });
});

describe('POST /api/folders/:folderId/shares', () => {
  it('crée un partage et renvoie 201', async () => {
    const folder = (await createFolder(ownerAgent, 'Partagé')).body;

    const shareResponse = await shareFolder(folder.id, GUEST_EMAIL, 'write');

    expect(shareResponse.status).toBe(201);
    expect(shareResponse.body.userId).toBe(guestUser.id);
    expect(shareResponse.body.email).toBe(GUEST_EMAIL);
    expect(shareResponse.body.permission).toBe('write');
    expect(shareResponse.body.firstName).toBeDefined();
    expect(shareResponse.body.createdAt).toBeDefined();
  });

  it('renvoie 404 pour un email inconnu', async () => {
    const folder = (await createFolder(ownerAgent, 'Partagé')).body;

    const shareResponse = await shareFolder(folder.id, UNKNOWN_EMAIL, 'read');

    expect(shareResponse.status).toBe(404);
  });

  it('renvoie 400 pour un partage avec soi-même', async () => {
    const folder = (await createFolder(ownerAgent, 'Partagé')).body;

    const shareResponse = await shareFolder(folder.id, OWNER_EMAIL, 'read');

    expect(shareResponse.status).toBe(400);
  });

  it('renvoie 400 pour une permission invalide', async () => {
    const folder = (await createFolder(ownerAgent, 'Partagé')).body;

    const shareResponse = await shareFolder(folder.id, GUEST_EMAIL, 'admin');

    expect(shareResponse.status).toBe(400);
  });

  it('renvoie 400 pour un email invalide', async () => {
    const folder = (await createFolder(ownerAgent, 'Partagé')).body;

    const shareResponse = await shareFolder(folder.id, 'pas-un-email', 'read');

    expect(shareResponse.status).toBe(400);
  });

  it('renvoie 400 pour un élément qui est un fichier', async () => {
    const file = (await createFile(ownerAgent, 'fichier.txt')).body;

    const shareResponse = await shareFolder(file.id, GUEST_EMAIL, 'read');

    expect(shareResponse.status).toBe(400);
  });

  it('renvoie 409 si le dossier est déjà partagé avec cet utilisateur', async () => {
    const folder = (await createFolder(ownerAgent, 'Partagé')).body;
    await shareFolder(folder.id, GUEST_EMAIL, 'read');

    const duplicateResponse = await shareFolder(folder.id, GUEST_EMAIL, 'write');

    expect(duplicateResponse.status).toBe(409);
  });

  it("renvoie 404 pour un utilisateur sans accès au dossier", async () => {
    const folder = (await createFolder(ownerAgent, 'Partagé')).body;

    const shareResponse = await strangerAgent.post(`/api/folders/${folder.id}/shares`).send({
      email: GUEST_EMAIL,
      permission: 'read',
    });

    expect(shareResponse.status).toBe(404);
  });

  it("renvoie 403 quand un invité tente de partager à son tour", async () => {
    const sharedFolder = await createSharedFolder('delete');

    const shareResponse = await guestAgent.post(`/api/folders/${sharedFolder.id}/shares`).send({
      email: STRANGER_EMAIL,
      permission: 'read',
    });

    expect(shareResponse.status).toBe(403);
  });
});

describe('GET /api/folders/:folderId/shares', () => {
  it('liste les partages pour le propriétaire', async () => {
    const folder = (await createFolder(ownerAgent, 'Partagé')).body;
    await shareFolder(folder.id, GUEST_EMAIL, 'write');

    const listingResponse = await ownerAgent.get(`/api/folders/${folder.id}/shares`);

    expect(listingResponse.status).toBe(200);
    expect(listingResponse.body.shares).toHaveLength(1);
    expect(listingResponse.body.shares[0]).toMatchObject({
      userId: guestUser.id,
      email: GUEST_EMAIL,
      permission: 'write',
    });
    expect(listingResponse.body.shares[0]).toHaveProperty('firstName');
    expect(listingResponse.body.shares[0]).toHaveProperty('lastName');
    expect(listingResponse.body.shares[0]).toHaveProperty('createdAt');
    expect(listingResponse.body.shares[0]).toHaveProperty('updatedAt');
  });

  it("renvoie 403 quand l'invité demande la liste", async () => {
    const sharedFolder = await createSharedFolder('delete');

    const listingResponse = await guestAgent.get(`/api/folders/${sharedFolder.id}/shares`);

    expect(listingResponse.status).toBe(403);
  });

  it('renvoie 404 sans aucun accès', async () => {
    const folder = (await createFolder(ownerAgent, 'Privé')).body;

    const listingResponse = await strangerAgent.get(`/api/folders/${folder.id}/shares`);

    expect(listingResponse.status).toBe(404);
  });
});

describe('PATCH /api/folders/:folderId/shares/:userId', () => {
  it('modifie la permission et la rend effective', async () => {
    const sharedFolder = await createSharedFolder('read');
    const deniedCreation = await createFile(guestAgent, 'avant.txt', sharedFolder.id);

    const updateResponse = await ownerAgent
      .patch(`/api/folders/${sharedFolder.id}/shares/${guestUser.id}`)
      .send({ permission: 'write' });
    const allowedCreation = await createFile(guestAgent, 'apres.txt', sharedFolder.id);

    expect(deniedCreation.status).toBe(403);
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.permission).toBe('write');
    expect(allowedCreation.status).toBe(201);
  });

  it('renvoie 400 pour une permission invalide', async () => {
    const sharedFolder = await createSharedFolder('read');

    const updateResponse = await ownerAgent
      .patch(`/api/folders/${sharedFolder.id}/shares/${guestUser.id}`)
      .send({ permission: 'admin' });

    expect(updateResponse.status).toBe(400);
  });

  it("renvoie 404 quand le dossier n'est pas partagé avec cet utilisateur", async () => {
    const folder = (await createFolder(ownerAgent, 'Partagé')).body;

    const updateResponse = await ownerAgent
      .patch(`/api/folders/${folder.id}/shares/${guestUser.id}`)
      .send({ permission: 'write' });

    expect(updateResponse.status).toBe(404);
  });

  it("renvoie 403 quand l'invité tente de modifier sa permission", async () => {
    const sharedFolder = await createSharedFolder('read');

    const updateResponse = await guestAgent
      .patch(`/api/folders/${sharedFolder.id}/shares/${guestUser.id}`)
      .send({ permission: 'delete' });

    expect(updateResponse.status).toBe(403);
  });
});

describe('DELETE /api/folders/:folderId/shares/:userId', () => {
  it("révoque le partage : l'invité reçoit ensuite 404", async () => {
    const sharedFolder = await createSharedFolder('write');

    const revocationResponse = await ownerAgent.delete(`/api/folders/${sharedFolder.id}/shares/${guestUser.id}`);
    const guestNodeResponse = await guestAgent.get(`/api/nodes/${sharedFolder.id}`);

    expect(revocationResponse.status).toBe(204);
    expect(guestNodeResponse.status).toBe(404);
  });

  it("permet à l'invité de quitter le partage", async () => {
    const sharedFolder = await createSharedFolder('write');

    const leaveResponse = await guestAgent.delete(`/api/folders/${sharedFolder.id}/shares/${guestUser.id}`);
    const guestNodeResponse = await guestAgent.get(`/api/nodes/${sharedFolder.id}`);
    const ownerNodeResponse = await ownerAgent.get(`/api/nodes/${sharedFolder.id}`);

    expect(leaveResponse.status).toBe(204);
    expect(guestNodeResponse.status).toBe(404);
    expect(ownerNodeResponse.status).toBe(200);
  });

  it("renvoie 404 quand il n'y a pas de partage", async () => {
    const folder = (await createFolder(ownerAgent, 'Partagé')).body;

    const revocationResponse = await ownerAgent.delete(`/api/folders/${folder.id}/shares/${guestUser.id}`);
    const leaveResponse = await guestAgent.delete(`/api/folders/${folder.id}/shares/${guestUser.id}`);

    expect(revocationResponse.status).toBe(404);
    expect(leaveResponse.status).toBe(404);
  });

  it("renvoie 403 quand un invité révoque le partage d'un autre invité", async () => {
    const sharedFolder = await createSharedFolder('delete');
    const strangerUser = (await strangerAgent.get('/api/auth/me')).body.user;
    await shareFolder(sharedFolder.id, STRANGER_EMAIL, 'read');

    const revocationResponse = await guestAgent.delete(`/api/folders/${sharedFolder.id}/shares/${strangerUser.id}`);

    expect(revocationResponse.status).toBe(403);
  });
});

describe('GET /api/folders/shared', () => {
  it("liste les dossiers partagés avec l'utilisateur, avec permission et propriétaire", async () => {
    const sharedFolder = await createSharedFolder('write');
    await createFile(ownerAgent, 'a.txt', sharedFolder.id);
    await createFolder(ownerAgent, 'NonPartage');

    const sharedResponse = await guestAgent.get('/api/folders/shared');

    expect(sharedResponse.status).toBe(200);
    expect(sharedResponse.body.folders).toHaveLength(1);
    expect(sharedResponse.body.folders[0]).toMatchObject({
      id: sharedFolder.id,
      name: 'Partagé',
      type: 'folder',
      childrenCount: 1,
      permission: 'write',
      owner: { id: ownerUser.id, email: OWNER_EMAIL },
    });
    expect(sharedResponse.body.folders[0].owner).toHaveProperty('firstName');
    expect(sharedResponse.body.folders[0].owner).toHaveProperty('lastName');
    expect(sharedResponse.body.folders[0]).toHaveProperty('updatedAt');
  });

  it("renvoie une liste vide quand rien n'est partagé", async () => {
    await createFolder(ownerAgent, 'NonPartage');

    const sharedResponse = await guestAgent.get('/api/folders/shared');

    expect(sharedResponse.body.folders).toEqual([]);
  });

  it("n'inclut plus le dossier après révocation", async () => {
    const sharedFolder = await createSharedFolder('read');
    await ownerAgent.delete(`/api/folders/${sharedFolder.id}/shares/${guestUser.id}`);

    const sharedResponse = await guestAgent.get('/api/folders/shared');

    expect(sharedResponse.body.folders).toEqual([]);
  });
});

describe('suppression du dossier partagé', () => {
  it('supprime les partages du dossier', async () => {
    const sharedFolder = await createSharedFolder('read');

    const deletionResponse = await ownerAgent.delete(`/api/nodes/${sharedFolder.id}`);
    const [remainingShareRows] = await pool.query('SELECT 1 FROM folder_shares WHERE folder_id = ?', [
      sharedFolder.id,
    ]);
    const sharedResponse = await guestAgent.get('/api/folders/shared');

    expect(deletionResponse.status).toBe(204);
    expect(remainingShareRows).toEqual([]);
    expect(sharedResponse.body.folders).toEqual([]);
  });
});

describe('droits administrateur', () => {
  it("lit le dossier d'un autre utilisateur avec la permission owner", async () => {
    const privateFolder = (await createFolder(ownerAgent, 'Privé')).body;
    const privateFile = (await createFile(ownerAgent, 'secret.txt', privateFolder.id, 'secret')).body;

    const nodeResponse = await adminAgent.get(`/api/nodes/${privateFolder.id}`);
    const listingResponse = await adminAgent.get(`/api/folders/${privateFolder.id}/children`);
    const contentResponse = await adminAgent.get(`/api/files/${privateFile.id}/content`);

    expect(nodeResponse.status).toBe(200);
    expect(nodeResponse.body.permission).toBe('owner');
    expect(listingResponse.status).toBe(200);
    expect(listingResponse.body.folder.permission).toBe('owner');
    expect(listingResponse.body.children.map((child) => child.name)).toEqual(['secret.txt']);
    expect(contentResponse.status).toBe(200);
    expect(contentResponse.body.content).toBe('secret');
  });

  it('renvoie le fil d\'Ariane complet pour un dossier imbriqué', async () => {
    const parentFolder = (await createFolder(ownerAgent, 'Parent')).body;
    const childFolder = (await createFolder(ownerAgent, 'Enfant', parentFolder.id)).body;

    const listingResponse = await adminAgent.get(`/api/folders/${childFolder.id}/children`);

    expect(listingResponse.body.breadcrumb.map((ancestor) => ancestor.id)).toEqual([parentFolder.id, childFolder.id]);
    expect(listingResponse.body.folder.parentId).toBe(parentFolder.id);
  });

  it("renomme et supprime l'élément d'un autre utilisateur", async () => {
    const privateFolder = (await createFolder(ownerAgent, 'Privé')).body;
    const privateFile = (await createFile(ownerAgent, 'secret.txt', privateFolder.id)).body;

    const renameResponse = await adminAgent.patch(`/api/nodes/${privateFile.id}`).send({ name: 'renomme.txt' });
    const deletionResponse = await adminAgent.delete(`/api/nodes/${privateFolder.id}`);
    const ownerNodeResponse = await ownerAgent.get(`/api/nodes/${privateFolder.id}`);

    expect(renameResponse.status).toBe(200);
    expect(renameResponse.body.name).toBe('renomme.txt');
    expect(deletionResponse.status).toBe(204);
    expect(ownerNodeResponse.status).toBe(404);
  });

  it("crée dans le dossier d'un autre utilisateur au nom du propriétaire du dossier", async () => {
    const privateFolder = (await createFolder(ownerAgent, 'Privé')).body;

    const fileCreation = await createFile(adminAgent, 'admin.txt', privateFolder.id);
    const folderCreation = await createFolder(adminAgent, 'SousDossier', privateFolder.id);
    const ownerListing = await ownerAgent.get(`/api/folders/${privateFolder.id}/children`);

    expect(fileCreation.status).toBe(201);
    expect(fileCreation.body.ownerId).toBe(ownerUser.id);
    expect(folderCreation.status).toBe(201);
    expect(folderCreation.body.ownerId).toBe(ownerUser.id);
    expect(ownerListing.body.children.map((child) => child.name)).toEqual(['SousDossier', 'admin.txt']);
  });

  it('liste à la racine les éléments de tous les utilisateurs', async () => {
    await createFolder(ownerAgent, 'DossierProprietaire');
    await createFolder(strangerAgent, 'DossierEtranger');
    await createFolder(adminAgent, 'DossierAdmin');

    const adminListing = await adminAgent.get('/api/folders/root/children');
    const ownerListing = await ownerAgent.get('/api/folders/root/children');

    expect(adminListing.body.children.map((child) => child.name)).toEqual([
      'DossierAdmin',
      'DossierEtranger',
      'DossierProprietaire',
    ]);
    expect(ownerListing.body.children.map((child) => child.name)).toEqual(['DossierProprietaire']);
  });

  it("donne accès à l'élément orphelin sans propriétaire", async () => {
    const formerAuthorAgent = await createAuthenticatedAgent(FORMER_AUTHOR_EMAIL);
    const orphanFolder = (await createFolder(formerAuthorAgent, 'Orphelin')).body;
    await deleteTestUser(FORMER_AUTHOR_EMAIL);

    const adminListing = await adminAgent.get('/api/folders/root/children');
    const adminNodeResponse = await adminAgent.get(`/api/nodes/${orphanFolder.id}`);
    const strangerNodeResponse = await strangerAgent.get(`/api/nodes/${orphanFolder.id}`);

    expect(adminListing.body.children.map((child) => child.name)).toContain('Orphelin');
    expect(adminNodeResponse.status).toBe(200);
    expect(adminNodeResponse.body.permission).toBe('owner');
    expect(strangerNodeResponse.status).toBe(404);
  });

  it("gère les partages du dossier d'un autre utilisateur", async () => {
    const privateFolder = (await createFolder(ownerAgent, 'Privé')).body;

    const shareResponse = await adminAgent
      .post(`/api/folders/${privateFolder.id}/shares`)
      .send({ email: GUEST_EMAIL, permission: 'read' });
    const listingResponse = await adminAgent.get(`/api/folders/${privateFolder.id}/shares`);
    const updateResponse = await adminAgent
      .patch(`/api/folders/${privateFolder.id}/shares/${guestUser.id}`)
      .send({ permission: 'write' });
    const revocationResponse = await adminAgent.delete(`/api/folders/${privateFolder.id}/shares/${guestUser.id}`);
    const guestNodeResponse = await guestAgent.get(`/api/nodes/${privateFolder.id}`);

    expect(shareResponse.status).toBe(201);
    expect(listingResponse.status).toBe(200);
    expect(listingResponse.body.shares.map((share) => share.email)).toEqual([GUEST_EMAIL]);
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.permission).toBe('write');
    expect(revocationResponse.status).toBe(204);
    expect(guestNodeResponse.status).toBe(404);
  });

  it("renvoie 400 pour partager le dossier avec l'email de son propriétaire", async () => {
    const privateFolder = (await createFolder(ownerAgent, 'Privé')).body;

    const shareResponse = await adminAgent
      .post(`/api/folders/${privateFolder.id}/shares`)
      .send({ email: OWNER_EMAIL, permission: 'read' });

    expect(shareResponse.status).toBe(400);
  });

  it("renvoie 400 pour déplacer l'élément d'un utilisateur vers la racine de l'administrateur", async () => {
    const parentFolder = (await createFolder(ownerAgent, 'Parent')).body;
    const movedFolder = (await createFolder(ownerAgent, 'Déplacé', parentFolder.id)).body;

    const moveResponse = await adminAgent.patch(`/api/nodes/${movedFolder.id}`).send({ parentId: null });
    const ownerNodeResponse = await ownerAgent.get(`/api/nodes/${movedFolder.id}`);

    expect(moveResponse.status).toBe(400);
    expect(ownerNodeResponse.body.parentId).toBe(parentFolder.id);
    expect(ownerNodeResponse.body.ownerId).toBe(ownerUser.id);
  });
});
