import { pool } from '../db.js';
import { HttpError } from '../errors/HttpError.js';

const ROOT_PARENT_KEY = 0;

function toNodeResponse(nodeRow) {
  return {
    id: nodeRow.id,
    parentId: nodeRow.parent_id,
    type: nodeRow.type,
    name: nodeRow.name,
    createdAt: nodeRow.created_at,
    updatedAt: nodeRow.updated_at,
  };
}

function toChildResponse(childRow) {
  const childResponse = {
    id: childRow.id,
    name: childRow.name,
    type: childRow.type,
    updatedAt: childRow.updated_at,
  };

  if (childRow.type === 'folder') {
    childResponse.childrenCount = Number(childRow.children_count);
  } else {
    childResponse.size = Number(childRow.size);
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
    'SELECT id, parent_id, type, name, created_at, updated_at FROM nodes WHERE id = ?',
    [nodeId],
  );
  return nodeRows[0] ?? null;
}

async function getExistingNode(nodeId, connection = pool) {
  const nodeRow = await findNodeById(nodeId, connection);
  if (!nodeRow) {
    throw new HttpError(404, 'Élément introuvable');
  }
  return nodeRow;
}

async function getExistingParentFolder(parentId, connection) {
  const parentRow = await findNodeById(parentId, connection);
  if (!parentRow) {
    throw new HttpError(400, 'Dossier parent introuvable');
  }
  if (parentRow.type !== 'folder') {
    throw new HttpError(400, "L'élément parent doit être un dossier");
  }
  return parentRow;
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

export async function listFolderChildren(folderId) {
  let folder = null;
  let breadcrumb = [];

  if (folderId !== null) {
    const folderRow = await getExistingNode(folderId);
    if (folderRow.type !== 'folder') {
      throw new HttpError(400, "Cet élément n'est pas un dossier");
    }
    folder = { id: folderRow.id, name: folderRow.name, parentId: folderRow.parent_id };
    breadcrumb = await getBreadcrumb(folderId);
  }

  const [childRows] = await pool.query(
    `SELECT node.id, node.name, node.type, node.updated_at,
            CHAR_LENGTH(file_content.content) AS size,
            (SELECT COUNT(*) FROM nodes AS grandchild WHERE grandchild.parent_id = node.id) AS children_count
     FROM nodes AS node
     LEFT JOIN file_contents AS file_content ON file_content.node_id = node.id
     WHERE node.parent_key = ?
     ORDER BY node.type = 'file', node.name`,
    [folderId ?? ROOT_PARENT_KEY],
  );

  return { folder, breadcrumb, children: childRows.map(toChildResponse) };
}

export async function getNode(nodeId) {
  return toNodeResponse(await getExistingNode(nodeId));
}

export async function createNode({ parentId, type, name, content }) {
  return withTransaction(async (connection) => {
    if (parentId !== null) {
      await getExistingParentFolder(parentId, connection);
    }

    const [insertResult] = await connection.query(
      'INSERT INTO nodes (parent_id, type, name) VALUES (?, ?, ?)',
      [parentId, type, name],
    );

    if (type === 'file') {
      await connection.query('INSERT INTO file_contents (node_id, content) VALUES (?, ?)', [
        insertResult.insertId,
        content,
      ]);
    }

    return toNodeResponse(await findNodeById(insertResult.insertId, connection));
  });
}

export async function updateNode(nodeId, { name, parentId, isMoveRequested }) {
  return withTransaction(async (connection) => {
    const nodeRow = await getExistingNode(nodeId, connection);
    const updatedName = name ?? nodeRow.name;
    let updatedParentId = nodeRow.parent_id;

    if (isMoveRequested) {
      if (parentId !== null) {
        await getExistingParentFolder(parentId, connection);
        const destinationAncestors = await getBreadcrumb(parentId, connection);
        const isMovingIntoItself = destinationAncestors.some((ancestor) => ancestor.id === nodeId);
        if (isMovingIntoItself) {
          throw new HttpError(400, 'Impossible de déplacer un dossier dans lui-même ou dans un de ses sous-dossiers');
        }
      }
      updatedParentId = parentId;
    }

    await connection.query('UPDATE nodes SET name = ?, parent_id = ? WHERE id = ?', [
      updatedName,
      updatedParentId,
      nodeId,
    ]);
    return toNodeResponse(await findNodeById(nodeId, connection));
  });
}

export async function deleteNode(nodeId) {
  await withTransaction(async (connection) => {
    await getExistingNode(nodeId, connection);
    const descendantIdsByDepth = await getDescendantIdsByDepth(nodeId, connection);
    for (const idsAtDepth of descendantIdsByDepth) {
      await connection.query('DELETE FROM nodes WHERE id IN (?)', [idsAtDepth]);
    }
  });
}

export async function getFileContent(fileId) {
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
  return { content: fileRow.content, version: fileRow.version, updatedAt: fileRow.updated_at };
}

export async function findFileDocument(fileId) {
  const [fileRows] = await pool.query(
    `SELECT file_content.content, file_content.yjs_state
     FROM file_contents AS file_content
     JOIN nodes AS node ON node.id = file_content.node_id
     WHERE node.id = ? AND node.type = 'file'`,
    [fileId],
  );

  const fileRow = fileRows[0];
  if (!fileRow) {
    return null;
  }
  return { content: fileRow.content, yjsState: fileRow.yjs_state };
}

export async function storeFileDocument(fileId, { content, yjsState }) {
  await pool.query(
    `UPDATE file_contents AS file_content
     JOIN nodes AS node ON node.id = file_content.node_id
     SET file_content.content = ?,
         file_content.yjs_state = ?,
         file_content.version = file_content.version + 1,
         file_content.updated_at = CURRENT_TIMESTAMP,
         node.updated_at = CURRENT_TIMESTAMP
     WHERE file_content.node_id = ?`,
    [content, yjsState, fileId],
  );
}
