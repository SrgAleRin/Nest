import path from 'node:path';
import os from 'node:os';
import { createCore } from '@nest/core';

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

const userData = userDataDir();
const dbPath = process.env.NEST_DB_PATH ?? path.join(userData, 'nest.db');
const worktreesRoot = process.env.NEST_WORKTREES_ROOT ?? path.join(userData, 'worktrees');
const fakeHarnessScript = path.resolve(process.cwd(), '../../scripts/fake-harness.mjs');

const core = createCore({ dbPath, worktreesRoot, fakeHarnessScript });

try {
  const existing = core.projects.list();
  if (existing.length > 0) {
    process.stdout.write(`Seed skipped: ${existing.length} project(s) already registered\n`);
  } else {
    const { project, checkout } = await core.projects.add(process.cwd());
    process.stdout.write(
      `Seeded ${project.name} (${project.path})\ncheckout: ${checkout.branch}\n`,
    );
  }
} finally {
  core.close();
}
