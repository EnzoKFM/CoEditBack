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

Réappliquer le schéma (idempotent) : `docker compose exec back npm run db:init`. **À faire si le volume MySQL existait avant l'ajout de la table `users`** : le schéma n'est appliqué automatiquement qu'à la création du volume.

Compte administrateur créé par le schéma : `admin@coedit.local` / `Admin1234!` (à changer).

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
| `JWT_SECRET` | Clé de signature des sessions, **obligatoire**, propre à chaque environnement |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` | Connexion MySQL (forcées par `docker-compose.yml` dans le conteneur) |
| `DB_NAME` | Base applicative |
| `DB_TEST_NAME` | Base des tests |
| `DB_EXPOSED_PORT` | Port MySQL publié sur l'hôte |

## Modèle de données

- `users` : comptes (`role` = `user` | `admin`), mot de passe haché avec bcrypt. `is_blocked` empêche la connexion et la navigation sur le site; `token_version` invalide les sessions ouvertes quand il est incrémenté (changement de mot de passe). `totp_secret` et `totp_enabled` sont réservés à la 2FA.
- `nodes` : dossiers et fichiers (`type` = `folder` | `file`), rattachés à leur parent par `parent_id` (`NULL` = racine). Deux éléments d'un même dossier ne peuvent pas porter le même nom (comparaison insensible à la casse, sensible aux accents). `owner_id` est réservé à la future authentification.
- `file_contents` : texte du document (`content`), `revision` (nombre d'opérations appliquées, voir la collaboration) et `version` (incrémentée à chaque sauvegarde).

## API

Toutes les erreurs renvoient `{ "error": "message" }` : 400 (requête invalide), 401 (non authentifié), 403 (accès refusé), 404 (élément introuvable), 409 (conflit de nom ou de version), 413 (corps > 5 Mo), 429 (trop de tentatives).

### Authentification

La session est un JWT placé dans un cookie `token` (`HttpOnly`, `SameSite=Strict`, 8 h), illisible par le JavaScript du front. Le front doit envoyer ses requêtes avec `credentials: 'include'` et appeler `GET /api/auth/me` au chargement pour savoir si l'utilisateur est connecté.

| Méthode | Route | Corps | Réponse |
|---|---|---|---|
| POST | `/api/auth/login` | `{ email, password }` | `{ user }` + cookie ; si 2FA active : `{ twoFactorRequired: true }` ; 401 identifiants incorrects, 403 compte bloqué |
| POST | `/api/auth/login/2fa` | `{ code }` | `{ user }` + cookie ; 401 code incorrect ou délai de 5 min dépassé |
| POST | `/api/auth/logout` | | 204, cookie supprimé |
| GET | `/api/auth/me` | | `{ user }` ; 401 sans session valide |

`user` vaut `{ id, email, firstName, lastName, role, totpEnabled }`.

`/login`, `/login/2fa` et la désactivation de la 2FA partagent une limite de 10 échecs par IP toutes les 15 minutes, puis renvoient 429 ; les requêtes réussies ne sont pas comptées. En développement, redémarrer l'API (`rs` dans nodemon) remet le compteur à zéro.

### Double authentification (TOTP)

Compatible Google Authenticator, Authy, Microsoft Authenticator… Routes réservées à l'utilisateur connecté :

| Méthode | Route | Corps | Réponse |
|---|---|---|---|
| POST | `/api/users/me/2fa/setup` | | `{ qrCode, secret }` : QR code (data URL pour un `<img>`) et secret pour une saisie manuelle. La 2FA n'est pas encore active ; 409 si elle l'est déjà |
| POST | `/api/users/me/2fa/enable` | `{ code }` | `{ user }` ; active la 2FA si le code est valide, 400 sinon |
| POST | `/api/users/me/2fa/disable` | `{ password, code }` | `{ user }` ; 400 si le mot de passe ou le code est incorrect |

Connexion d'un compte avec 2FA : `/login` vérifie le mot de passe et pose un cookie temporaire `pending_2fa` (5 min), qui n'ouvre pas de session ; `/login/2fa` vérifie le code et pose le vrai cookie de session. Le code est accepté avec une tolérance de 30 s, et les espaces sont ignorés.

Pour protéger une route : `requireAuth` (401 si non connecté, expose `request.user`) et `requireAdmin` (403 si non admin), dans `src/middlewares/auth.js`. Un compte bloqué perd sa session dès la requête suivante.

### Documents

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
