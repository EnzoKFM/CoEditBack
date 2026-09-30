import { pool } from '../db.js';
import { HttpError } from '../errors/HttpError.js';

const ROOT_PARENT_KEY = 0;
const ROOT_OWNER_KEY_OUTSIDE_ROOT = 0;

const PERMISSION_RANKS = { none: 0, read: 1, write: 2, delete: 3, owner: 4 };

const AUTHOR_COLUMNS = `node.created_by, creator.first_name AS creator_first_name, creator.last_name AS creator_last_name,
            node.updated_by, updater.first_name AS updater_first_name, updater.last_name AS updater_last_name`;
const AUTHOR_JOINS = `LEFT JOIN users AS creator ON creator.id = node.created_by
     LEFT JOIN users AS updater ON updater.id = node.updated_by`;

function toPermissionName(permissionRank) {
  return Object.keys(PERMISSION_RANKS).find((permissionName) => PERMISSION_RANKS[permissionName] === permissionRank);
}

function toAuthorResponse(userId, firstName, lastName) {
  if (!userId || !firstName) {
    return null;
  }
  return { id: userId, name: `${firstName} ${lastName}` };
}

function toAuthorsResponse(nodeRow) {
  return {
    createdBy: toAuthorResponse(nodeRow.created_by, nodeRow.creator_first_name, nodeRow.creator_last_name),
    updatedBy: toAuthorResponse(nodeRow.updated_by, nodeRow.updater_first_name, nodeRow.updater_last_name),
  };
}

function toNodeResponse(nodeRow) {
  return {
    id: nodeRow.id,
    parentId: nodeRow.parent_id,
    type: nodeRow.type,
    name: nodeRow.name,
    ownerId: nodeRow.owner_id,
    mimeType: nodeRow.mime_type,
    createdAt: nodeRow.created_at,
    updatedAt: nodeRow.updated_at,
    ...toAuthorsResponse(nodeRow),
  };
}

function toChildResponse(childRow) {
  const childResponse = {
    id: childRow.id,
    name: childRow.name,
    type: childRow.type,
    createdAt: childRow.created_at,
    updatedAt: childRow.updated_at,
    ...toAuthorsResponse(childRow),
  };

  if (childRow.type === 'folder') {
    childResponse.childrenCount = Number(childRow.children_count);
  } else {
    childResponse.size = Number(childRow.size);
    childResponse.mimeType = childRow.mime_type;
  }
  return childResponse;
}

async function withTransaction(transactionCallback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const transactionResult = await transactionCallback(connection);
    await connection.commit();
    return transactionResult;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function findNodeById(nodeId, connection = pool) {
  const [nodeRows] = await connection.query(
    `SELECT node.id, node.parent_id, node.type, node.name, node.owner_id, node.created_at, node.updated_at,
            ${AUTHOR_COLUMNS}, file_binary.mime_type
     FROM nodes AS node
     ${AUTHOR_JOINS}
     LEFT JOIN file_binaries AS file_binary ON file_binary.node_id = node.id
     WHERE node.id = ?`,
    [nodeId],
  );
  return nodeRows[0] ?? null;
}

async function findNodeAccess(nodeId, user, connection = pool) {
  const nodeRow = await findNodeById(nodeId, connection);
  if (!nodeRow) {
    return null;
  }
  if (nodeRow.owner_id === user.id || user.role === 'admin') {
    return {
      nodeRow,
      permissionRank: PERMISSION_RANKS.owner,
      itemPermissionRank: PERMISSION_RANKS.owner,
      shareRootDepth: null,
    };
  }

  const [sharedAncestorRows] = await connection.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id, 0 AS depth FROM nodes WHERE id = ?
       UNION ALL
       SELECT parent.id, parent.parent_id, ancestors.depth + 1
       FROM nodes AS parent
       JOIN ancestors ON parent.id = ancestors.parent_id
     )
     SELECT ancestors.depth, folder_share.permission
     FROM ancestors
     JOIN folder_shares AS folder_share ON folder_share.folder_id = ancestors.id AND folder_share.user_id = ?`,
    [nodeId, user.id],
  );

  let permissionRank = PERMISSION_RANKS.none;
  let itemPermissionRank = PERMISSION_RANKS.none;
  let shareRootDepth = null;
  for (const sharedAncestorRow of sharedAncestorRows) {
    const sharePermissionRank = PERMISSION_RANKS[sharedAncestorRow.permission];
    permissionRank = Math.max(permissionRank, sharePermissionRank);
    if (sharedAncestorRow.depth > 0) {
      itemPermissionRank = Math.max(itemPermissionRank, sharePermissionRank);
    }
    shareRootDepth = Math.max(shareRootDepth ?? 0, sharedAncestorRow.depth);
  }
  return { nodeRow, permissionRank, itemPermissionRank, shareRootDepth };
}

async function getAccessibleNode(nodeId, user, connection = pool) {
  const nodeAccess = await findNodeAccess(nodeId, user, connection);
  if (!nodeAccess || nodeAccess.permissionRank === PERMISSION_RANKS.none) {
    throw new HttpError(404, 'Élément introuvable');
  }
  return nodeAccess;
}

function assertPermission(permissionRank, requiredPermissionRank) {
  if (permissionRank < requiredPermissionRank) {
    throw new HttpError(403, 'Droits insuffisants sur cet élément');
  }
}

export async function findFileAccess(fileId, user) {
  const nodeAccess = await findNodeAccess(fileId, user);
  if (!nodeAccess || nodeAccess.nodeRow.type !== 'file' || nodeAccess.permissionRank === PERMISSION_RANKS.none) {
    return null;
  }
  return { permission: toPermissionName(nodeAccess.permissionRank), canEdit: nodeAccess.permissionRank >= PERMISSION_RANKS.write };
}

export async function getOwnedFolder(folderId, user, connection = pool) {
  const nodeAccess = await getAccessibleNode(folderId, user, connection);
  if (nodeAccess.nodeRow.type !== 'folder') {
    throw new HttpError(400, "Cet élément n'est pas un dossier");
  }
  if (nodeAccess.permissionRank !== PERMISSION_RANKS.owner) {
    throw new HttpError(403, 'Seul le propriétaire du dossier peut gérer ses partages');
  }
  return nodeAccess.nodeRow;
}

async function getWritableParentFolder(parentId, user, connection) {
  const parentAccess = await findNodeAccess(parentId, user, connection);
  if (!parentAccess || parentAccess.permissionRank === PERMISSION_RANKS.none) {
    throw new HttpError(400, 'Dossier parent introuvable');
  }
  if (parentAccess.nodeRow.type !== 'folder') {
    throw new HttpError(400, "L'élément parent doit être un dossier");
  }
  assertPermission(parentAccess.permissionRank, PERMISSION_RANKS.write);
  return parentAccess.nodeRow;
}

async function getBreadcrumb(folderId, connection = pool) {
  const [ancestorRows] = await connection.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id, name, 0 AS depth FROM nodes WHERE id = ?
       UNION ALL
       SELECT parent.id, parent.parent_id, parent.name, ancestors.depth + 1
       FROM nodes AS parent
       JOIN ancestors ON parent.id = ancestors.parent_id
     )
     SELECT id, name FROM ancestors ORDER BY depth DESC`,
    [folderId],
  );
  return ancestorRows.map((ancestorRow) => ({ id: ancestorRow.id, name: ancestorRow.name }));
}

async function getDescendantIdsByDepth(nodeId, connection) {
  const [descendantRows] = await connection.query(
    `WITH RECURSIVE descendants AS (
       SELECT id, 0 AS depth FROM nodes WHERE id = ?
       UNION ALL
       SELECT child.id, descendants.depth + 1
       FROM nodes AS child
       JOIN descendants ON child.parent_id = descendants.id
     )
     SELECT id, depth FROM descendants ORDER BY depth DESC`,
    [nodeId],
  );

  const descendantIdsByDepth = new Map();
  for (const descendantRow of descendantRows) {
    const idsAtDepth = descendantIdsByDepth.get(descendantRow.depth) ?? [];
    idsAtDepth.push(descendantRow.id);
    descendantIdsByDepth.set(descendantRow.depth, idsAtDepth);
  }
  return [...descendantIdsByDepth.values()];
}

export async function listFolderChildren(folderId, user) {
  let folder = null;
  let breadcrumb = [];

  if (folderId !== null) {
    const { nodeRow: folderRow, permissionRank, shareRootDepth } = await getAccessibleNode(folderId, user);
    if (folderRow.type !== 'folder') {
      throw new HttpError(400, "Cet élément n'est pas un dossier");
    }
    const isShareRoot = shareRootDepth === 0;
    folder = {
      id: folderRow.id,
      name: folderRow.name,
      parentId: isShareRoot ? null : folderRow.parent_id,
      permission: toPermissionName(permissionRank),
    };
    const fullBreadcrumb = await getBreadcrumb(folderId);
    breadcrumb = shareRootDepth === null ? fullBreadcrumb : fullBreadcrumb.slice(-(shareRootDepth + 1));
  }

    const [childRows] = await pool.query(
    `SELECT node.id, node.name, node.type, node.created_at, node.updated_at,
            ${AUTHOR_COLUMNS},
            COALESCE(CHAR_LENGTH(file_content.content), file_binary.size) AS size,
            file_binary.mime_type,
            (SELECT COUNT(*) FROM nodes AS grandchild WHERE grandchild.parent_id = node.id) AS children_count
     FROM nodes AS node
     LEFT JOIN file_contents AS file_content ON file_content.node_id = node.id
     LEFT JOIN file_binaries AS file_binary ON file_binary.node_id = node.id
     ${AUTHOR_JOINS}
     WHERE node.parent_key = ? AND (? OR node.root_owner_key = ?)
     ORDER BY node.type = 'file', node.name`,
    [
      folderId ?? ROOT_PARENT_KEY,
      folderId === null && user.role === 'admin',
      folderId === null ? user.id : ROOT_OWNER_KEY_OUTSIDE_ROOT,
    ],
  );

  return { folder, breadcrumb, children: childRows.map(toChildResponse) };
}

export async function getNode(nodeId, user) {
  const { nodeRow, permissionRank } = await getAccessibleNode(nodeId, user);
  return { ...toNodeResponse(nodeRow), permission: toPermissionName(permissionRank) };
}

export async function createNode({ parentId, type, name, content, binaryFile, user }) {
  return withTransaction(async (connection) => {
    let ownerId = user.id;
    if (parentId !== null) {
      const parentRow = await getWritableParentFolder(parentId, user, connection);
      ownerId = parentRow.owner_id;
    }

    const [insertResult] = await connection.query(
      'INSERT INTO nodes (parent_id, type, name, owner_id, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)',
      [parentId, type, name, ownerId, user.id, user.id],
    );

    if (binaryFile) {
      await connection.query('INSERT INTO file_binaries (node_id, mime_type, data, size) VALUES (?, ?, ?, ?)', [
        insertResult.insertId,
        binaryFile.mimeType,
        binaryFile.data,
        binaryFile.data.length,
      ]);
    } else if (type === 'file') {
      await connection.query('INSERT INTO file_contents (node_id, content) VALUES (?, ?)', [
        insertResult.insertId,
        content,
      ]);
    }

    return toNodeResponse(await findNodeById(insertResult.insertId, connection));
  });
}

export async function updateNode(nodeId, user, { name, parentId, isMoveRequested }) {
  return withTransaction(async (connection) => {
    const { nodeRow, itemPermissionRank } = await getAccessibleNode(nodeId, user, connection);
    assertPermission(itemPermissionRank, isMoveRequested ? PERMISSION_RANKS.delete : PERMISSION_RANKS.write);
    const updatedName = name ?? nodeRow.name;
    let updatedParentId = nodeRow.parent_id;

    if (isMoveRequested) {
      const destinationOwnerId =
        parentId === null ? user.id : (await getWritableParentFolder(parentId, user, connection)).owner_id;
      if (destinationOwnerId !== nodeRow.owner_id) {
        throw new HttpError(400, "Impossible de déplacer un élément vers l'espace d'un autre utilisateur");
      }
      if (parentId !== null) {
        const destinationAncestors = await getBreadcrumb(parentId, connection);
        const isMovingIntoItself = destinationAncestors.some((ancestor) => ancestor.id === nodeId);
        if (isMovingIntoItself) {
          throw new HttpError(400, 'Impossible de déplacer un dossier dans lui-même ou dans un de ses sous-dossiers');
        }
      }
      updatedParentId = parentId;
    }

    await connection.query(
      'UPDATE nodes SET name = ?, parent_id = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [updatedName, updatedParentId, user.id, nodeId],
    );
    return toNodeResponse(await findNodeById(nodeId, connection));
  });
}

export async function deleteNode(nodeId, user) {
  await withTransaction(async (connection) => {
    const { itemPermissionRank } = await getAccessibleNode(nodeId, user, connection);
    assertPermission(itemPermissionRank, PERMISSION_RANKS.delete);
    const descendantIdsByDepth = await getDescendantIdsByDepth(nodeId, connection);
    for (const idsAtDepth of descendantIdsByDepth) {
      await connection.query('DELETE FROM nodes WHERE id IN (?)', [idsAtDepth]);
    }
  });
}

export async function getFileContent(fileId, user) {
  await getAccessibleNode(fileId, user);
  const [fileRows] = await pool.query(
    `SELECT node.type, file_content.content, file_content.version, file_content.updated_at
     FROM nodes AS node
     LEFT JOIN file_contents AS file_content ON file_content.node_id = node.id
     WHERE node.id = ?`,
    [fileId],
  );

  const fileRow = fileRows[0];
  if (!fileRow) {
    throw new HttpError(404, 'Élément introuvable');
  }
  if (fileRow.type !== 'file') {
    throw new HttpError(400, "Cet élément n'est pas un fichier");
  }
  if (fileRow.content === null) {
    throw new HttpError(400, "Ce fichier n'est pas un document texte");
  }
  return { content: fileRow.content, version: fileRow.version, updatedAt: fileRow.updated_at };
}

export async function getBinaryFile(fileId, user) {
  const { nodeRow } = await getAccessibleNode(fileId, user);
  if (nodeRow.type !== 'file') {
    throw new HttpError(400, "Cet élément n'est pas un fichier");
  }

  const [binaryFileRows] = await pool.query(
    'SELECT mime_type, data, version, updated_at FROM file_binaries WHERE node_id = ?',
    [fileId],
  );
  const binaryFileRow = binaryFileRows[0];
  if (!binaryFileRow) {
    throw new HttpError(400, 'Ce fichier est un document texte : son contenu se lit via /content');
  }
  return {
    name: nodeRow.name,
    mimeType: binaryFileRow.mime_type,
    data: binaryFileRow.data,
    version: binaryFileRow.version,
    updatedAt: binaryFileRow.updated_at,
  };
}

export async function replaceBinaryFile(fileId, user, { mimeType, data }) {
  return withTransaction(async (connection) => {
    const { nodeRow, permissionRank } = await getAccessibleNode(fileId, user, connection);
    if (nodeRow.type !== 'file') {
      throw new HttpError(400, "Cet élément n'est pas un fichier");
    }
    assertPermission(permissionRank, PERMISSION_RANKS.write);

    const [updateResult] = await connection.query(
      `UPDATE file_binaries AS file_binary
       JOIN nodes AS node ON node.id = file_binary.node_id
       SET file_binary.mime_type = ?,
           file_binary.data = ?,
           file_binary.size = ?,
           file_binary.version = file_binary.version + 1,
           file_binary.updated_at = CURRENT_TIMESTAMP,
           node.updated_at = CURRENT_TIMESTAMP
       WHERE file_binary.node_id = ?`,
      [mimeType, data, data.length, fileId],
    );
    if (updateResult.affectedRows === 0) {
      throw new HttpError(400, 'Ce fichier est un document texte : son contenu se modifie en temps réel');
    }
    return toNodeResponse(await findNodeById(fileId, connection));
  });
}

export async function findFileDocument(fileId) {
  const [fileRows] = await pool.query(
    `SELECT file_content.content, file_content.revision
     FROM file_contents AS file_content
     JOIN nodes AS node ON node.id = file_content.node_id
     WHERE node.id = ? AND node.type = 'file'`,
    [fileId],
  );

  const fileRow = fileRows[0];
  if (!fileRow) {
    return null;
  }
  return { content: fileRow.content, revision: fileRow.revision };
}

export async function storeFileDocument(fileId, { content, revision, updatedBy = null }) {
  await pool.query(
    `UPDATE file_contents AS file_content
     JOIN nodes AS node ON node.id = file_content.node_id
     SET file_content.content = ?,
         file_content.revision = ?,
         file_content.version = file_content.version + 1,
         file_content.updated_at = CURRENT_TIMESTAMP,
         node.updated_at = CURRENT_TIMESTAMP,
         node.updated_by = COALESCE(?, node.updated_by)
     WHERE file_content.node_id = ?`,
    [content, revision, updatedBy, fileId],
  );
}
