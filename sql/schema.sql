CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
  is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  -- Secret chiffré (AES-256-GCM, clé TOTP_ENCRYPTION_KEY), jamais en clair
  totp_secret VARCHAR(255) NULL,
  totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Dernier créneau de 30 s accepté : un code déjà utilisé ne peut pas être rejoué
  totp_last_time_step BIGINT UNSIGNED NULL,
  -- Incrémenté au changement de mot de passe : invalide les sessions existantes
  token_version INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Admin par défaut : admin@coedit.local / Admin1234! (à changer après la première connexion)
INSERT IGNORE INTO users (email, password_hash, first_name, last_name, role)
VALUES (
  'admin@coedit.local',
  '$2b$12$JNnbKxuRSG7eaI.HM4oU1Op2AxLh0enPmvkaVBbCMmISTYl9HUUOS',
  'Admin',
  'Coedit',
  'admin'
);

CREATE TABLE IF NOT EXISTS nodes (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  parent_id INT UNSIGNED NULL,
  parent_key INT UNSIGNED AS (COALESCE(parent_id, 0)) VIRTUAL,
  type ENUM('folder', 'file') NOT NULL,
  name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci NOT NULL,
  owner_id INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_nodes_parent_name (parent_key, name),
  KEY idx_nodes_parent (parent_id),
  CONSTRAINT fk_nodes_parent FOREIGN KEY (parent_id) REFERENCES nodes (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS file_contents (
  node_id INT UNSIGNED NOT NULL,
  content LONGTEXT NOT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (node_id),
  CONSTRAINT fk_file_contents_node FOREIGN KEY (node_id) REFERENCES nodes (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
