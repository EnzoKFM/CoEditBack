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
- `file_contents` : état Yjs du document (`yjs_state`), sa copie en texte brut (`content`) et un numéro de `version` incrémenté à chaque sauvegarde.

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

Le serveur [Hocuspocus](https://tiptap.dev/docs/hocuspocus) écoute en WebSocket sur `ws://localhost:3000/collaboration`, sur le même port que l'API. Les éditions simultanées sont fusionnées par [Yjs](https://docs.yjs.dev) sans conflit.

- **Nom du document** : l'identifiant du fichier, en chaîne (`"9"`). Une connexion à un identifiant inexistant, à un dossier ou à un nom non numérique est refusée.
- **Texte** : `document.getText('content')` (`Y.Text`), à relier à l'éditeur du front (par exemple `y-codemirror.next` ou `y-monaco`).
- **Sauvegarde** : réalisée par le serveur, 2 s après la dernière modification, au plus tard toutes les 10 s pendant une frappe continue, et immédiatement quand le dernier éditeur quitte le document. Le front n'a rien à enregistrer.
- **Présence (curseurs, souris)** : via l'awareness Yjs, relayée par le serveur sans être stockée. Convention proposée pour le front :

```js
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

const document = new Y.Doc();
const provider = new HocuspocusProvider({
  url: 'ws://localhost:3000/collaboration',
  name: String(fileId),
  document,
});

provider.setAwarenessField('user', { name: 'Alice', color: '#e67e22' });
provider.setAwarenessField('pointer', { x: 120, y: 348 });
provider.awareness.on('change', () => {
  const connectedUsers = [...provider.awareness.getStates().values()];
});
```

Le curseur et la sélection dans le texte sont diffusés par le binding d'éditeur (`y-codemirror.next`, `y-monaco`) à partir de cette même awareness.
