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
    } else if (version !== 1) {
      throw new Error('Unsupported Diffloop database version');
    }
    db.exec('COMMIT');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
