import { DatabaseSync } from 'node:sqlite';

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (version === 0) {
      db.exec(`
        CREATE TABLE credentials (ref TEXT PRIMARY KEY, ciphertext BLOB NOT NULL);
        CREATE TABLE connections (
          id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, login TEXT NOT NULL,
          credential_ref TEXT NOT NULL UNIQUE REFERENCES credentials(ref)
        );
        PRAGMA user_version = 1;
      `);
    } else if (version !== 1 && version !== 2) {
      throw new Error('Unsupported Diffloop database version');
    }
    if (version !== 2) db.exec(`
      ALTER TABLE connections ADD COLUMN status TEXT NOT NULL DEFAULT 'connected';
      ALTER TABLE connections ADD COLUMN last_pulled_at TEXT;
      CREATE TABLE saved_queries (
        id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id),
        query TEXT NOT NULL, UNIQUE(connection_id, query)
      );
      CREATE TABLE pull_requests (
        id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id),
        remote_id TEXT NOT NULL, repository TEXT NOT NULL,
        number INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'open',
        UNIQUE(connection_id, remote_id)
      );
      CREATE TABLE pull_resources (
        pr_id TEXT NOT NULL REFERENCES pull_requests(id), kind TEXT NOT NULL,
        data TEXT, cached_at TEXT, revision TEXT, error TEXT, complete INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(pr_id, kind)
      );
      PRAGMA user_version = 2;
    `);
    db.exec('COMMIT');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
