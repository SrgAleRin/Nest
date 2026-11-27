import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/index.js';
import './gitEnv.js';

// realpath expands Windows 8.3 names (RUNNER~1) so paths match git output.
const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-git-sides-')));
const repoPath = path.join(tempRoot, 'repo');
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

function write(name: string, content: string): void {
  writeFileSync(path.join(repoPath, name), content, 'utf8');
}

/** Distinct lines, so a numstat count is unambiguous. */
function lines(count: number, prefix: string): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`).join('');
}

const BASE = lines(10, 'base');
/** `HEAD → index`: ten appended lines, nothing removed. */
const PARTIAL_INDEX = BASE + lines(10, 'staged');
/** `index → worktree`: one more appended line. */
const PARTIAL_WORKTREE = PARTIAL_INDEX + 'worktree 1\n';
/** `HEAD → index`: ten appended lines; the worktree then drops them again. */
const REVERTED_INDEX = `base 1\n${lines(10, 'staged')}`;

beforeAll(async () => {
  mkdirSync(repoPath, { recursive: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Nest']);
  git(['config', 'user.email', 'nest@example.com']);
  git(['config', 'core.autocrlf', 'false']);
  write('partial.txt', BASE);
  write('reverted.txt', 'base 1\n');
  git(['add', '.']);
  git(['commit', '-m', 'seed']);

  // Partially staged: index +10, worktree +1 more.
  write('partial.txt', PARTIAL_INDEX);
  git(['add', '--', 'partial.txt']);
  write('partial.txt', PARTIAL_WORKTREE);

  // Staged work reverted in the worktree: index +10, worktree -10.
  write('reverted.txt', REVERTED_INDEX);
  git(['add', '--', 'reverted.txt']);
  write('reverted.txt', 'base 1\n');

  write('untracked.md', 'a\nb\nc\nd\n');

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

describe('per-side status counters', () => {
  it('counts a partially staged file per side and keeps the aggregate sum', async () => {
    const status = await core!.git.status(taskId);
    const file = status.files.find((entry) => entry.path === 'partial.txt');

    expect(file).toMatchObject({
      staged: true,
      unstaged: true,
      stagedAdditions: 10,
      stagedDeletions: 0,
      unstagedAdditions: 1,
      unstagedDeletions: 0,
      additions: 11,
      deletions: 0,
    });
  });

  it('counts staged work reverted in the worktree instead of dropping both counters', async () => {
    // `git diff HEAD` is empty here, so a single aggregate read would lose both
    // counters; each side still has its own diff.
    expect(git(['diff', '--numstat', 'HEAD', '--', 'reverted.txt'])).toBe('');
    const status = await core!.git.status(taskId);
    const file = status.files.find((entry) => entry.path === 'reverted.txt');

    expect(file).toMatchObject({
      staged: true,
      unstaged: true,
      stagedAdditions: 10,
      stagedDeletions: 0,
      unstagedAdditions: 0,
      unstagedDeletions: 10,
      additions: 10,
      deletions: 10,
    });
  });

  it('reports an untracked file with no staged side and its line count on the worktree side', async () => {
    const status = await core!.git.status(taskId);
    const file = status.files.find((entry) => entry.path === 'untracked.md');

    expect(file).toMatchObject({
      untracked: true,
      staged: false,
      unstaged: true,
      stagedAdditions: null,
      stagedDeletions: null,
      unstagedAdditions: 4,
      unstagedDeletions: 0,
      additions: 4,
      deletions: 0,
    });
  });

  it('leaves the aggregate counter unknown when one side is binary', async () => {
    writeFileSync(path.join(repoPath, 'partial.txt'), Buffer.from([0, 1, 2, 0]));
    try {
      const status = await core!.git.status(taskId);
      const file = status.files.find((entry) => entry.path === 'partial.txt');

      // A binary worktree side has no line counts, so the aggregate of the side
      // that did change lines is unknown; the untouched counter stays a number.
      expect(file).toMatchObject({
        stagedAdditions: 10,
        stagedDeletions: 0,
        unstagedAdditions: null,
        unstagedDeletions: null,
        additions: null,
        deletions: 0,
      });
    } finally {
      write('partial.txt', PARTIAL_WORKTREE);
    }
  });
});
