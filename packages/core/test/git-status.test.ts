import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/index.js';

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-git-status-'));
const repoPath = path.join(tempRoot, 'repo');
let core: Core | null = null;
let taskId = '';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

beforeAll(async () => {
  mkdirSync(repoPath, { recursive: true });
  git(['init', '-b', 'main'], repoPath);
  writeFileSync(path.join(repoPath, 'tracked.txt'), 'one\ntwo\n', 'utf8');
  git(['add', '.'], repoPath);
  git(
    ['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', 'init'],
    repoPath,
  );

  // One modified tracked file, one staged addition, one untracked file and a
  // binary blob that git reports without line counts.
  writeFileSync(path.join(repoPath, 'tracked.txt'), 'one\nTWO\nthree\n', 'utf8');
  writeFileSync(path.join(repoPath, 'staged.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
  git(['add', 'staged.ts'], repoPath);
  writeFileSync(path.join(repoPath, 'untracked.md'), 'a\nb\nc\nd\n', 'utf8');
  writeFileSync(path.join(repoPath, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0]));

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

describe('git status line counts', () => {
  it('reports counts for tracked, staged and untracked files', async () => {
    const status = await core!.git.status(taskId);
    const byPath = new Map(status.files.map((file) => [file.path, file]));

    expect(byPath.get('tracked.txt')).toMatchObject({
      additions: 2,
      deletions: 1,
      untracked: false,
    });
    expect(byPath.get('staged.ts')).toMatchObject({
      additions: 2,
      deletions: 0,
      staged: true,
    });
    expect(byPath.get('untracked.md')).toMatchObject({
      additions: 4,
      deletions: 0,
      untracked: true,
    });
    expect(byPath.get('blob.bin')).toMatchObject({ additions: null, deletions: null });
  });

  it('reports a missing workspace instead of a missing git binary', async () => {
    const moved = `${repoPath}-moved`;
    renameSync(repoPath, moved);
    try {
      await expect(core!.git.status(taskId)).rejects.toMatchObject({
        code: 'workspace_missing',
      });
    } finally {
      renameSync(moved, repoPath);
    }
  });
});
