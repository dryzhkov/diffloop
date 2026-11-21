import { safeStorage } from 'electron';
import type { DatabaseSync } from 'node:sqlite';

function available() {
  return safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
}

export function credentials(db: DatabaseSync) {
  return {
    available,
    save(ref: string, token: string) {
      if (!available()) throw new Error('OS credential encryption unavailable');
      db.prepare('INSERT INTO credentials VALUES (?, ?) ON CONFLICT(ref) DO UPDATE SET ciphertext = excluded.ciphertext')
        .run(ref, safeStorage.encryptString(token));
    },
    read(ref: string) {
      const bytes = db.prepare('SELECT ciphertext FROM credentials WHERE ref = ?').get(ref)?.ciphertext;
      if (!(bytes instanceof Uint8Array)) return undefined;
      if (!available()) throw new Error('OS credential encryption unavailable');
      return safeStorage.decryptString(Buffer.from(bytes));
    },
  };
}
