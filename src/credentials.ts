import { app, safeStorage } from 'electron';
import { execFileSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';

// Chromium picks its backend before app readiness. Hyprland sessions can
// expose Secret Service even when Chromium does not recognize the desktop.
export function configureCredentialStorage() {
  if (process.platform !== 'linux' || app.commandLine.hasSwitch('password-store') ||
    process.env.XDG_CURRENT_DESKTOP?.split(':').some(desktop => desktop.toLowerCase() === 'kde')) return;

  const service = 'org.freedesktop.secrets';
  const call = (method: string, ...args: string[]) => execFileSync('gdbus', [
    'call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
    '--method', `org.freedesktop.DBus.${method}`, ...args,
  ], { encoding: 'utf8', timeout: 750, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    if (call('NameHasOwner', service) === '(true,)' || call('ListActivatableNames').includes(`'${service}'`)) {
      app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
    }
  } catch {
    // Keep Electron's native selection if the D-Bus probe is unavailable.
  }
}

async function encrypt(token: string) {
  const ciphertext = await safeStorage.encryptStringAsync(token);
  // On Linux, v11 denotes a keyring-backed key. Reject the fixed-key
  // fallback even if Chromium reports that it can encrypt.
  if (process.platform === 'linux' && ciphertext.subarray(0, 3).toString('ascii') !== 'v11') {
    throw new Error('OS credential encryption unavailable');
  }
  return ciphertext;
}

async function available() {
  if (process.platform === 'linux' &&
    !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(safeStorage.getSelectedStorageBackend())) return false;
  try {
    if (!await safeStorage.isAsyncEncryptionAvailable()) return false;
    if (process.platform === 'linux') await encrypt('Diffloop keyring check');
    return true;
  } catch {
    return false;
  }
}

export function credentials(db: DatabaseSync) {
  return {
    available,
    async encrypt(token: string) {
      if (!await available()) throw new Error('OS credential encryption unavailable');
      return encrypt(token);
    },
    save(ref: string, ciphertext: Uint8Array) {
      db.prepare('INSERT INTO credentials VALUES (?, ?) ON CONFLICT(ref) DO UPDATE SET ciphertext = excluded.ciphertext')
        .run(ref, ciphertext);
    },
    forget(ref: string) {
      db.prepare("UPDATE credentials SET ciphertext = X'' WHERE ref = ?").run(ref);
    },
    async read(ref: string) {
      const bytes = db.prepare('SELECT ciphertext FROM credentials WHERE ref = ?').get(ref)?.ciphertext;
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) return undefined;
      if (!await available()) throw new Error('OS credential encryption unavailable');
      const { result } = await safeStorage.decryptStringAsync(Buffer.from(bytes));
      return result;
    },
  };
}
