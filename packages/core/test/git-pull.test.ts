import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/index.js';
import './gitEnv.js';

// realpath expands Windows 8.3 names (RUNNER~1) so paths match git output.
const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-git-pull-')));
const originPath = path.join(tempRoot, 'origin.git');
const repoPath = path.join(tempRoot, 'repo');
const clonePath = path.join(tempRoot, 'clone');
let core: Core | null = null;
let taskId = '';

function git(args: string[], cwd = repoPath): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  })
    .replace(/\r\n/g, '\n')
    .trim();
}

function file(name: string, cwd = repoPath): string {
  return path.join(cwd, name);
}

function configure(cwd: string): void {
  git(['config', 'user.name', 'Nest'], cwd);
  git(['config', 'user.email', 'nest@example.com'], cwd);
  git(['config', 'core.autocrlf', 'false'], cwd);
}

beforeAll(async () => {
  mkdirSync(repoPath, { recursive: true });
  git(['init', '-b', 'main']);
  configure(repoPath);
  writeFileSync(file('README.md'), '# pull\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-m', 'init']);

  git(['init', '--bare', '--initial-branch=main', originPath], tempRoot);
  git(['remote', 'add', 'origin', originPath]);
  git(['push', '-u', 'origin', 'main']);

  core = createCore({
    dbPath: path.join(tempRoot, 'nest.db'),
    worktreesRoot: path.join(tempRoot, 'worktrees'),
    fakeHarnessScript: path.join(tempRoot, 'missing-harness.mjs'),
  });
  const { project } = await core.projects.add(repoPath);
  taskId = core.tasks.ensureCheckout(project.id).id;
});

afterAll(() => {
  core?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('pull', () => {
  it('fast-forwards an upstream commit and refuses a diverged branch', async () => {
    execFileSync('git', ['clone', originPath, clonePath], {
      cwd: tempRoot,
      stdio: 'pipe',
      windowsHide: true,
    });
    configure(clonePath);
    writeFileSync(file('remote.txt', clonePath), 'remote work\n', 'utf8');
    git(['add', '-A'], clonePath);
    git(['commit', '-m', 'remote commit'], clonePath);
    git(['push'], clonePath);

    // The checkout keeps working and moves to the upstream commit.
    await core!.git.pull(taskId);
    expect(git(['log', '-1', '--format=%s'])).toBe('remote commit');
    expect(await core!.git.status(taskId)).toMatchObject({ ahead: 0, behind: 0 });

    // A local commit plus a new upstream commit diverge; pull stays ff-only.
    writeFileSync(file('local.txt'), 'local work\n', 'utf8');
    await core!.git.stage(taskId, ['local.txt']);
    await core!.git.commit(taskId, 'local commit');
    const localHead = git(['rev-parse', 'HEAD']);

    writeFileSync(file('remote.txt', clonePath), 'remote work\ntwo\n', 'utf8');
    git(['commit', '-am', 'remote second'], clonePath);
    git(['push'], clonePath);
    await core!.git.fetch(taskId);

    await expect(core!.git.pull(taskId)).rejects.toMatchObject({
      code: 'pull_not_fast_forward',
    });
    // Nothing was merged or rebased behind the user's back.
    expect(git(['rev-parse', 'HEAD'])).toBe(localHead);
    expect(git(['status', '--porcelain'])).toBe('');
  });
});
