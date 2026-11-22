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
    } else if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) {
      throw new Error('Unsupported Diffloop database version');
    }
    if (version === 0 || version === 1) db.exec(`
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
    if (Number(version) < 3) db.exec(`
      CREATE TABLE attention_state (
        pr_id TEXT PRIMARY KEY REFERENCES pull_requests(id) ON DELETE CASCADE,
        observation TEXT NOT NULL, snoozed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE attention_events (
        pr_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
        event_key TEXT NOT NULL, kind TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        acknowledged INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(pr_id,event_key)
      );
      PRAGMA user_version = 3;
    `);
    if (Number(version) < 4) db.exec(`
      CREATE TABLE drafts (
        id TEXT PRIMARY KEY, pr TEXT NOT NULL REFERENCES pull_requests(id), target TEXT NOT NULL,
        head TEXT NOT NULL, body TEXT NOT NULL, included INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'local', detail TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE push_attempts (
        id TEXT PRIMARY KEY, draft TEXT NOT NULL, payload TEXT NOT NULL, hash TEXT NOT NULL,
        baseline TEXT NOT NULL, status TEXT NOT NULL, remote_id TEXT, started TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished TEXT
      );
      CREATE INDEX attempts_by_draft ON push_attempts(draft);
      PRAGMA user_version = 4;
    `);
    if (Number(version) < 5) db.exec(`
      CREATE TABLE agent_grants (
        connection TEXT NOT NULL REFERENCES connections(id), repository TEXT NOT NULL,
        policy TEXT NOT NULL, PRIMARY KEY(connection, repository)
      );
      CREATE TABLE agent_local_roots (
        connection TEXT NOT NULL REFERENCES connections(id), repository TEXT NOT NULL,
        path TEXT NOT NULL, PRIMARY KEY(connection, repository)
      );
      CREATE TABLE agent_configs (
        id TEXT PRIMARY KEY, connection TEXT NOT NULL REFERENCES connections(id), config TEXT NOT NULL
      );
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY, pr TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
        record TEXT NOT NULL
      );
      CREATE INDEX agent_runs_by_pr ON agent_runs(pr);
      ALTER TABLE drafts ADD COLUMN agentRunId TEXT REFERENCES agent_runs(id);
      ALTER TABLE drafts ADD COLUMN findingId TEXT;
      PRAGMA user_version = 5;
    `);
    db.exec('COMMIT');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
