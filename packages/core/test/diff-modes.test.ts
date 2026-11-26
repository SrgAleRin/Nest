import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiffFile, GitDiff } from '@nest/shared';
import { createCore, type Core } from '../src/index.js';
import './gitEnv.js';

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-diff-modes-'));
const repoPath = path.join(tempRoot, 'repo');

let core: Core | null = null;
let projectId = '';
let checkoutId = '';
let worktreeId = '';
/** Workspace of the worktree task the diff modes are tested against. */
let workspace = '';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function write(content: string, name: string, root = workspace): void {
  writeFileSync(path.join(root, name), content, 'utf8');
}

function read(name: string, root = workspace): string {
  return readFileSync(path.join(root, name), 'utf8');
}

function fileByPath(diff: GitDiff, filePath: string, staged?: boolean): DiffFile | undefined {
  return diff.files.find(
    (file) => file.path === filePath && (staged === undefined || file.staged === staged),
  );
}

/** Added lines as [new-side line number, text]; new-side numbers are the anchors. */
function addedLines(file: DiffFile | undefined): Array<[number, string]> {
  if (!file) throw new Error('diff file is missing');
  return file.hunks.flatMap((hunk) =>
    hunk.lines
      .filter((line) => line.type === 'add')
      .map((line): [number, string] => [line.newLine ?? 0, line.text]),
  );
}

beforeAll(async () => {
  mkdirSync(repoPath, { recursive: true });
  git(['init', '-b', 'main'], repoPath);
  git(['config', 'user.name', 'Nest'], repoPath);
  git(['config', 'user.email', 'nest@example.com'], repoPath);
  write('one\ntwo\nthree\n', 'base.txt', repoPath);
  write('line1\nline2\n', 'partial.txt', repoPath);
  git(['add', '.'], repoPath);
  git(['commit', '-m', 'init'], repoPath);

  core = createCore({
    dbPath: path.join(tempRoot, 'nest.db'),
    worktreesRoot: path.join(tempRoot, 'worktrees'),
    fakeHarnessScript: path.join(tempRoot, 'missing-harness.mjs'),
  });
  const { project } = await core.projects.add(repoPath);
  projectId = project.id;
  checkoutId = core.tasks.ensureCheckout(projectId).id;

  const task = await core.tasks.create({ projectId, title: 'diff modes', baseBranch: 'main' });
  worktreeId = task.id;
  workspace = task.workspacePath;

  // One file per state the modes must distinguish: staged only, unstaged only,
  // partially staged (index keeps line3, the worktree adds line4) and untracked.
  write('const staged = 1;\nconst stagedTwo = 2;\n', 'staged-only.ts');
  git(['add', 'staged-only.ts'], workspace);
  write('unstaged line\n', 'unstaged-only.ts');
  write('line1\nline2\nline3\n', 'partial.txt');
  git(['add', 'partial.txt'], workspace);
  write('line1\nline2\nline3\nline4\n', 'partial.txt');
  write('untracked\n', 'untracked.txt');
});

afterAll(() => {
  core?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('diff modes', () => {
  it('shows a staged-only file in the default flow', async () => {
    const diff = await core!.git.diff(worktreeId);

    expect(diff.descriptor).toEqual({
      mode: 'both',
      baseRef: null,
      workspaceIncludesIndex: false,
      anchorSide: 'mixed',
    });
    // The default view is a per-file union, so a full index never reads as
    // "no changes to review".
    const sides = diff.files.map((file) => `${file.path}:${file.staged ? 'staged' : 'unstaged'}`);
    expect(sides).toContain('staged-only.ts:staged');
    expect(sides).toContain('unstaged-only.ts:unstaged');
    expect(sides).toContain('partial.txt:staged');
    expect(sides).toContain('partial.txt:unstaged');
    expect(sides).toContain('untracked.txt:unstaged');
  });

  it('reports the staged side with index line numbers', async () => {
    const diff = await core!.git.diff(worktreeId, { mode: 'staged' });

    expect(diff.descriptor).toMatchObject({ mode: 'staged', baseRef: null, anchorSide: 'index' });
    expect(addedLines(fileByPath(diff, 'staged-only.ts'))).toEqual([
      [1, 'const staged = 1;'],
      [2, 'const stagedTwo = 2;'],
    ]);
    // Worktree-only and untracked files are not on this side.
    expect(fileByPath(diff, 'unstaged-only.ts')).toBeUndefined();
    expect(fileByPath(diff, 'untracked.txt')).toBeUndefined();
    // Only the staged part of a partially staged file: the index stops at line3.
    expect(addedLines(fileByPath(diff, 'partial.txt', true))).toEqual([[3, 'line3']]);
  });

  it('reports the unstaged side with working tree line numbers', async () => {
    const diff = await core!.git.diff(worktreeId, { mode: 'unstaged' });

    expect(diff.descriptor).toMatchObject({
      mode: 'unstaged',
      baseRef: null,
      anchorSide: 'worktree',
    });
    expect(addedLines(fileByPath(diff, 'unstaged-only.ts'))).toEqual([[1, 'unstaged line']]);
    expect(addedLines(fileByPath(diff, 'untracked.txt'))).toEqual([[1, 'untracked']]);
    expect(fileByPath(diff, 'staged-only.ts')).toBeUndefined();
    // The index already has line3, so the worktree change starts at line4.
    expect(addedLines(fileByPath(diff, 'partial.txt', false))).toEqual([[4, 'line4']]);
  });

  it('compares the workspace against the recorded task base, index included', async () => {
    const diff = await core!.git.diff(worktreeId, { mode: 'base' });

    expect(diff.descriptor).toEqual({
      mode: 'base',
      baseRef: 'main',
      workspaceIncludesIndex: true,
      anchorSide: 'worktree',
    });
    // Both index-only and worktree-only work is visible, because the workspace
    // side is the working tree with the index applied.
    expect(fileByPath(diff, 'staged-only.ts')).toBeDefined();
    expect(fileByPath(diff, 'unstaged-only.ts')).toBeDefined();
    expect(fileByPath(diff, 'untracked.txt')).toBeDefined();
    expect(addedLines(fileByPath(diff, 'partial.txt'))).toEqual([
      [3, 'line3'],
      [4, 'line4'],
    ]);
    expect(addedLines(fileByPath(diff, 'staged-only.ts'))).toEqual([
      [1, 'const staged = 1;'],
      [2, 'const stagedTwo = 2;'],
    ]);
  });

  it('labels the base of a checkout that sits on its own base branch as HEAD', async () => {
    write('one\nTWO\nthree\n', 'base.txt', repoPath);
    write('staged in the checkout\n', 'checkout-only.js', repoPath);
    git(['add', 'checkout-only.js'], repoPath);

    const diff = await core!.git.diff(checkoutId, { mode: 'base' });
    expect(diff.descriptor).toMatchObject({ mode: 'base', baseRef: 'HEAD' });
    expect(diff.descriptor.workspaceIncludesIndex).toBe(true);
    expect(diff.files.map((file) => file.path).sort()).toEqual(['base.txt', 'checkout-only.js']);
  });

  it('scopes a mode to one path when a file is named', async () => {
    const diff = await core!.git.diff(worktreeId, { mode: 'staged', path: 'staged-only.ts' });
    expect(diff.files.map((file) => file.path)).toEqual(['staged-only.ts']);
  });
});

describe('stage and unstage from the diff panel', () => {
  it('stages and unstages a tracked file without touching the worktree copy', async () => {
    const before = read('unstaged-only.ts');

    const stagedStatus = await core!.git.stage(worktreeId, ['unstaged-only.ts']);
    expect(read('unstaged-only.ts')).toBe(before);
    expect(stagedStatus.files.find((file) => file.path === 'unstaged-only.ts')).toMatchObject({
      staged: true,
      worktreeStatus: ' ',
    });
    const stagedDiff = await core!.git.diff(worktreeId, { mode: 'staged' });
    expect(fileByPath(stagedDiff, 'unstaged-only.ts')?.staged).toBe(true);

    const unstagedStatus = await core!.git.unstage(worktreeId, ['unstaged-only.ts']);
    expect(read('unstaged-only.ts')).toBe(before);
    // Unstaging a file that was never committed leaves it untracked, not gone.
    expect(unstagedStatus.files.find((file) => file.path === 'unstaged-only.ts')).toMatchObject({
      staged: false,
      untracked: true,
    });
  });

  it('round-trips a staged file back to the same staged state', async () => {
    const before = read('staged-only.ts');

    const unstagedStatus = await core!.git.unstage(worktreeId, ['staged-only.ts']);
    expect(read('staged-only.ts')).toBe(before);
    expect(unstagedStatus.files.find((file) => file.path === 'staged-only.ts')).toMatchObject({
      staged: false,
      untracked: true,
    });

    const stagedStatus = await core!.git.stage(worktreeId, ['staged-only.ts']);
    expect(read('staged-only.ts')).toBe(before);
    expect(stagedStatus.files.find((file) => file.path === 'staged-only.ts')).toMatchObject({
      staged: true,
      untracked: false,
    });
  });

  it('refuses paths outside the workspace', async () => {
    await expect(core!.git.stage(worktreeId, ['../outside.txt'])).rejects.toMatchObject({
      code: 'invalid_path',
    });
    await expect(
      core!.git.unstage(worktreeId, [path.join(repoPath, 'base.txt')]),
    ).rejects.toMatchObject({ code: 'invalid_path' });
  });
});
