# AGENTS.md

Consignes pour les agents IA (Claude Code, Codex, Cursor…) qui travaillent sur ce dépôt.

## Projet

CoEditBack est l'API de CoEdit, un « Google Drive » de documents texte co-édités en temps réel. Le back stocke l'arborescence des dossiers et fichiers ainsi que leur contenu, et héberge le serveur de collaboration. Le front est un dépôt séparé, qui n'est pas lancé dans Docker.

Stack : Node 22 (ESM), Express 5, MySQL 8.4 via `mysql2/promise` (SQL écrit à la main, sans ORM), Socket.IO et une transformation opérationnelle (OT) maison pour le temps réel, vitest 3 et supertest pour les tests.

## Commandes

Tout tourne dans Docker. `src/`, `sql/`, `tests/` et `vitest.config.js` sont montés dans le conteneur `back`, et nodemon recharge l'API à chaque modification.

```bash
docker compose up -d --build          # API sur :3000 et MySQL ; obligatoire après un changement de dépendances
docker compose exec back npm test     # suite complète
docker compose exec back npx vitest run -t "<nom du test>"
docker compose exec back npm run db:init
```

Le Node de l'hôte peut être trop ancien : ne pas lancer les tests hors du conteneur.

## Architecture

```
sql/schema.sql                         schéma, en CREATE TABLE IF NOT EXISTS
src/app.js                             application Express (routes et gestion des erreurs), sans listen
src/server.js                          écoute HTTP et branchement de Socket.IO
src/routes/*.js                        /api/folders, /api/nodes, /api/files (envoi multipart des binaires via multer)
src/controllers/nodeController.js      lecture de la requête, validation, appel du service
src/validators/nodeValidator.js        parse ou lève une HttpError 400
src/services/nodeService.js            tout le SQL des nœuds, avec les transactions (withTransaction) et le calcul des droits (findNodeAccess)
src/services/shareService.js           partages de dossiers (folder_shares)
src/collaboration/textOperation.js     OT pure : parse, application, transformation d'opérations
src/collaboration/documentSession.js   document en mémoire : révision, historique, présence, sauvegarde
src/collaboration/collaborationServer.js  événements Socket.IO, chargement et déchargement des sessions
src/errors/HttpError.js, src/middlewares/errorHandler.js
tests/*.test.js                        tests d'intégration sur une vraie base MySQL de test
```

Modèle de données :
- `nodes` : dossiers et fichiers, organisés en liste d'adjacence (`parent_id` vaut NULL à la racine). Le nom est unique par dossier via `UNIQUE(parent_key, root_owner_key, name)`, où `parent_key` = `COALESCE(parent_id, 0)` couvre aussi la racine et `root_owner_key` = `owner_id` à la racine (0 ailleurs) y rend l'unicité propre à chaque propriétaire.
- `file_contents` : `content`, `revision` (nombre d'opérations OT appliquées), `version` (nombre de sauvegardes).
- `file_binaries` : fichiers binaires (PDF, images…), `mime_type`, `data` en `LONGBLOB`, `size`, `version` (nombre de remplacements). Un fichier a soit une ligne `file_contents`, soit une ligne `file_binaries`.
- `folder_shares` : partage d'un dossier avec un utilisateur, permission `read` < `write` < `delete`, héritée par tous les descendants. Tout nœud porte l'`owner_id` de la racine de son arbre ; tout accès passe par `findNodeAccess` (un administrateur y a le rang propriétaire sur tout nœud), et un nœud inaccessible répond 404.

## Règles à respecter

- **Yjs est interdit** (consigne du projet), ainsi que tout ce qui repose dessus (Hocuspocus, y-websocket, bindings y-*). Ne pas introduire d'autre bibliothèque de synchronisation (ShareDB, Automerge…) sans accord explicite.
- **Aucune écriture de contenu texte en REST.** Un document texte ne se modifie que par l'événement Socket.IO `document:operation`, et c'est le serveur qui sauvegarde (`DocumentSession.store`). Une route d'écriture de contenu texte contournerait l'OT. Seuls les fichiers binaires se remplacent en REST (`PUT /api/files/:fileId/binary`), qui refuse les documents texte.
- **Le serveur fait autorité** : toute opération est transformée contre l'historique depuis sa révision de base, dans `receiveOperation`, qui reste synchrone pour que l'ordre des opérations soit garanti. Toute modification de `textOperation.js` doit garder la convergence (testée dans `tests/textOperation.test.js`).
- **Suppression d'un dossier** : elle se fait niveau par niveau, du plus profond au plus haut (`deleteNode`), parce qu'InnoDB limite les cascades à 15 niveaux (erreur 3008). Ne pas la remplacer par un simple `DELETE`.
- **Évolution du schéma** : `schema.sql` ne crée que les tables absentes. Signaler toute modification, car les bases existantes doivent être migrées à la main ou recréées (`docker compose down -v`). La base de test, elle, est recréée à chaque lancement.
- **Erreurs** : lever une `HttpError(status, message)`. Les messages destinés au client sont en français. `ER_DUP_ENTRY` est converti en 409 par `errorHandler`.
- **Express 5** : les rejets des handlers async remontent seuls jusqu'à `errorHandler`, donc pas de wrapper `asyncHandler`.

## Conventions de code

- Identifiants en anglais et camelCase, messages et logs en français.
- **Aucun commentaire dans le code** : le nommage doit suffire.
- Des noms auto-explicatifs, jamais `res`, `data`, `x`, `tmp` ; l'itérateur prend le singulier de la collection (`childRows` → `childRow`).
- Le changement doit rester minimal, sans refactoring opportuniste.

## Tests

- Tests d'intégration sur la base `DB_TEST_NAME` (`coedit_test`), vidée avant chaque test. Un garde-fou empêche de viser la base applicative.
- Avant de faire confiance à un résultat, comparer `md5sum <fichier>` sur l'hôte et dans le conteneur (`docker compose exec back md5sum <fichier>`).
- Tout test de régression doit être discriminant : il échoue sur le code d'avant le correctif et passe après.
- Tests de collaboration : utiliser `createCollaboration({ storeDebounceMs, storeMaxDebounceMs })` avec des délais courts, et des attentes par condition plutôt que des `setTimeout` fixes.

## Git

- Commits et PR en français, sans aucune mention d'IA ni trailer `Co-Authored-By`.
- Branches `feat/<mots>` ou `fix/<mots>` (3 mots maximum, séparés par `_`), créées depuis `develop`. PR vers `develop`, jamais vers `main`.
- Jamais de commit ni de push sans validation explicite de l'humain.
- Mettre à jour le `README.md` (routes, modèle, collaboration) avec tout changement fonctionnel.
