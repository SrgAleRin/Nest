import path from 'node:path';
import os from 'node:os';
import { rmSync } from 'node:fs';

function userDataDir(): string {
  const profile = process.env.NEST_PROFILE?.trim();
  const appData =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'));

  const base = path.join(appData, 'Nest');
  return profile ? path.join(base, 'profiles', profile) : base;
}

const dbPath = process.env.NEST_DB_PATH ?? path.join(userDataDir(), 'nest.db');

for (const suffix of ['', '-wal', '-shm']) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}

process.stdout.write(`Removed ${dbPath}\n`);
