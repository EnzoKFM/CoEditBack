import { pool } from '../db.js';
import { HttpError } from '../errors/HttpError.js';
import { getOwnedFolder } from './nodeService.js';

function toShareResponse(shareRow) {
  return {
    userId: shareRow.user_id,
    email: shareRow.email,
    firstName: shareRow.first_name,
    lastName: shareRow.last_name,
    permission: shareRow.permission,
    createdAt: shareRow.created_at,
    updatedAt: shareRow.updated_at,
  };
}

function toSharedFolderResponse(sharedFolderRow) {
  return {
    id: sharedFolderRow.id,
    name: sharedFolderRow.name,
    type: sharedFolderRow.type,
    updatedAt: sharedFolderRow.updated_at,
    childrenCount: Number(sharedFolderRow.children_count),
    permission: sharedFolderRow.permission,
    owner: {
      id: sharedFolderRow.owner_id,
      email: sharedFolderRow.owner_email,
      firstName: sharedFolderRow.owner_first_name,
      lastName: sharedFolderRow.owner_last_name,
    },
  };
}

async function findShare(folderId, userId) {
  const [shareRows] = await pool.query(
    `SELECT folder_share.user_id, folder_share.permission, folder_share.created_at, folder_share.updated_at,
            invitee.email, invitee.first_name, invitee.last_name
     FROM folder_shares AS folder_share
     JOIN users AS invitee ON invitee.id = folder_share.user_id
     WHERE folder_share.folder_id = ? AND folder_share.user_id = ?`,
    [folderId, userId],
  );
  return shareRows[0] ?? null;
}

async function getExistingShare(folderId, userId) {
  const shareRow = await findShare(folderId, userId);
  if (!shareRow) {
    throw new HttpError(404, "Ce dossier n'est pas partagé avec cet utilisateur");
  }
  return shareRow;
}

export async function listFolderShares(folderId, requester) {
  await getOwnedFolder(folderId, requester);
  const [shareRows] = await pool.query(
    `SELECT folder_share.user_id, folder_share.permission, folder_share.created_at, folder_share.updated_at,
            invitee.email, invitee.first_name, invitee.last_name
     FROM folder_shares AS folder_share
     JOIN users AS invitee ON invitee.id = folder_share.user_id
     WHERE folder_share.folder_id = ?
     ORDER BY invitee.last_name, invitee.first_name, invitee.id`,
    [folderId],
  );
  return shareRows.map(toShareResponse);
}

export async function shareFolder(folderId, requester, { email, permission }) {
  const folderRow = await getOwnedFolder(folderId, requester);
  const [inviteeRows] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  const invitee = inviteeRows[0];
  if (!invitee) {
    throw new HttpError(404, 'Aucun compte ne correspond à cet email');
  }
  if (invitee.id === folderRow.owner_id) {
    throw new HttpError(400, 'Impossible de partager un dossier avec son propriétaire');
  }

  try {
    await pool.query('INSERT INTO folder_shares (folder_id, user_id, permission) VALUES (?, ?, ?)', [
      folderId,
      invitee.id,
      permission,
    ]);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, 'Ce dossier est déjà partagé avec cet utilisateur');
    }
    throw error;
  }
  return toShareResponse(await findShare(folderId, invitee.id));
}

export async function updateFolderShare(folderId, requester, inviteeId, permission) {
  await getOwnedFolder(folderId, requester);
  await getExistingShare(folderId, inviteeId);
  await pool.query('UPDATE folder_shares SET permission = ? WHERE folder_id = ? AND user_id = ?', [
    permission,
    folderId,
    inviteeId,
  ]);
  return toShareResponse(await findShare(folderId, inviteeId));
}

export async function deleteFolderShare(folderId, requester, inviteeId) {
  const isLeavingShare = requester.id === inviteeId;
  if (!isLeavingShare) {
    await getOwnedFolder(folderId, requester);
  }
  await getExistingShare(folderId, inviteeId);
  await pool.query('DELETE FROM folder_shares WHERE folder_id = ? AND user_id = ?', [folderId, inviteeId]);
}

export async function listSharedFolders(userId) {
  const [sharedFolderRows] = await pool.query(
    `SELECT node.id, node.name, node.type, node.updated_at, folder_share.permission,
            owner.id AS owner_id, owner.email AS owner_email,
            owner.first_name AS owner_first_name, owner.last_name AS owner_last_name,
            (SELECT COUNT(*) FROM nodes AS child WHERE child.parent_id = node.id) AS children_count
     FROM folder_shares AS folder_share
     JOIN nodes AS node ON node.id = folder_share.folder_id
     JOIN users AS owner ON owner.id = node.owner_id
     WHERE folder_share.user_id = ?
     ORDER BY node.name, node.id`,
    [userId],
  );
  return sharedFolderRows.map(toSharedFolderResponse);
}
