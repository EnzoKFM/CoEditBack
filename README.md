# CoEditBack

API de CoEdit : stockage de documents texte rangés dans une arborescence de dossiers, et co-édition de ces documents en temps réel.

## Démarrage (Docker)

Le back et MySQL 8.4 tournent dans Docker ; le front tourne sur l'hôte.

```bash
cp .env.example .env
docker compose up -d --build
```

- API : http://localhost:3000 (`GET /api/health`).
- MySQL est exposé sur le port `DB_EXPOSED_PORT` (3306 par défaut). Le schéma `sql/schema.sql` est appliqué automatiquement au premier démarrage du volume.
- `src/`, `sql/` et `tests/` sont montés dans le conteneur ; `nodemon` recharge l'API à chaque modification.

Réappliquer le schéma (idempotent) : `docker compose exec back npm run db:init`. Le schéma ne crée que les tables absentes : après une évolution de `sql/schema.sql`, recréer le volume (`docker compose down -v`) ou appliquer la modification à la main.

## Tests

```bash
docker compose exec back npm test
```

Les tests d'intégration utilisent une base dédiée (`DB_TEST_NAME`, `coedit_test` par défaut), créée automatiquement et vidée avant chaque test. Elle doit être différente de `DB_NAME`.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `PORT` | Port de l'API (3000) |
| `CLIENT_URL` | Origine autorisée par CORS (front) |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` | Connexion MySQL (forcées par `docker-compose.yml` dans le conteneur) |
| `DB_NAME` | Base applicative |
| `DB_TEST_NAME` | Base des tests |
| `DB_EXPOSED_PORT` | Port MySQL publié sur l'hôte |

## Modèle de données

- `nodes` : dossiers et fichiers (`type` = `folder` | `file`), rattachés à leur parent par `parent_id` (`NULL` = racine). Deux éléments d'un même dossier ne peuvent pas porter le même nom (comparaison insensible à la casse, sensible aux accents). `owner_id` est réservé à la future authentification.
- `file_contents` : texte du document (`content`), `revision` (nombre d'opérations appliquées, voir la collaboration) et `version` (incrémentée à chaque sauvegarde).

## API

Toutes les erreurs renvoient `{ "error": "message" }` : 400 (requête invalide), 404 (élément introuvable), 409 (conflit de nom), 413 (corps > 5 Mo).

| Méthode | Route | Corps | Réponse |
|---|---|---|---|
| GET | `/api/folders/root/children` | | Contenu de la racine |
| GET | `/api/folders/:folderId/children` | | Contenu d'un dossier |
| POST | `/api/nodes` | `{ parentId, type, name, content? }` | 201 + élément créé |
| GET | `/api/nodes/:nodeId` | | Métadonnées de l'élément |
| PATCH | `/api/nodes/:nodeId` | `{ name?, parentId? }` | Élément renommé et/ou déplacé |
| DELETE | `/api/nodes/:nodeId` | | 204, descendants compris |
| GET | `/api/files/:fileId/content` | | `{ content, version, updatedAt }` |

### Listage d'un dossier

```json
{
  "folder": { "id": 4, "name": "Cours", "parentId": 1 },
  "breadcrumb": [{ "id": 1, "name": "Projets" }, { "id": 4, "name": "Cours" }],
  "children": [
    { "id": 7, "name": "TP", "type": "folder", "childrenCount": 3, "updatedAt": "2026-09-28T10:00:00.000Z" },
    { "id": 9, "name": "notes.txt", "type": "file", "size": 1204, "updatedAt": "2026-09-28T10:05:00.000Z" }
  ]
}
```

À la racine, `folder` vaut `null` et `breadcrumb` est vide. Les dossiers sont listés avant les fichiers, puis par nom.

### Déplacement

`parentId: null` déplace l'élément à la racine. Un dossier ne peut pas être déplacé dans lui-même ni dans un de ses sous-dossiers (400).

### Lecture du contenu

`GET /api/files/:fileId/content` renvoie la dernière copie texte sauvegardée. Le contenu ne se modifie pas en REST : toute édition passe par la collaboration temps réel.

## Collaboration temps réel

La synchronisation repose sur une transformation opérationnelle (OT) écrite pour le projet, sans Yjs. Le transport est [Socket.IO](https://socket.io), sur le même port que l'API (`http://localhost:3000`, chemin par défaut `/socket.io`). Le serveur fait autorité : il ordonne les opérations, les transforme, les applique, puis les diffuse.

### Opérations

Une opération décrit tout le document, dans l'ordre, sous forme d'une liste de composants :

```js
[{ retain: 6 }, { insert: 'cher ' }, { retain: 5 }, { delete: 3 }]
```

`retain` conserve des caractères, `insert` en ajoute, `delete` en supprime. La somme des `retain` et `delete` doit égaler la longueur du document de départ. Les positions sont comptées en unités UTF-16 (`string.length` en JavaScript). Le module [src/collaboration/textOperation.js](src/collaboration/textOperation.js), sans dépendance, peut être copié tel quel dans le front (`applyOperation`, `transformOperation`, `transformIndex`).

### Événements

| Sens | Événement | Contenu |
|---|---|---|
| client → serveur | `document:join` (ack) | `{ fileId, user: { name, color } }` → `{ clientId, content, revision, collaborators }` ou `{ error }` |
| client → serveur | `document:operation` (ack) | `{ revision, operation }` → `{ revision }` ou `{ error, isResyncRequired }` |
| client → serveur | `presence:update` | `{ selection: { anchor, head } \| null, pointer: { x, y } \| null }` |
| client → serveur | `document:leave` | |
| serveur → clients | `document:operation` | `{ clientId, revision, operation }` |
| serveur → clients | `presence:update` | `{ clientId, user, selection, pointer }` |
| serveur → clients | `presence:leave` | `{ clientId }` |

- `revision` est la révision du document sur laquelle l'opération a été écrite. Le serveur la transforme contre les opérations appliquées depuis, puis renvoie la nouvelle révision dans l'accusé.
- Un fichier inexistant, un dossier ou un identifiant invalide est refusé à `document:join`.
- `isResyncRequired: true` signale une révision antérieure au chargement du document en mémoire (après une reconnexion par exemple) : il faut rejoindre à nouveau le document.
- La présence n'est pas stockée. Le serveur transforme toutefois les sélections qu'il connaît à chaque opération, pour qu'un nouvel arrivant les reçoive à jour dans `collaborators`.

### Algorithme côté front

1. À l'ouverture, `document:join`, puis afficher `content` et mémoriser `revision`.
2. Une modification locale est appliquée tout de suite. Si aucune opération n'attend d'accusé, l'envoyer avec `revision` ; sinon, la mettre en tampon.
3. À l'accusé : `revision` prend la valeur reçue, et la première opération du tampon part à son tour.
4. À la réception d'une `document:operation` d'un autre client : `[enAttente, reçue] = transformOperation(enAttente, reçue)`, puis même chose avec chaque opération du tampon dans l'ordre, puis appliquer `reçue` au texte et faire `revision = message.revision`. Les curseurs distants sont décalés avec `transformIndex`.

### Sauvegarde

Le serveur sauvegarde lui-même : 2 s après la dernière opération, au plus tard toutes les 10 s pendant une frappe continue, et tout de suite quand le dernier éditeur quitte le document. Le front n'a rien à enregistrer.
