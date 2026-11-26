import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/index.js';
import './gitEnv.js';

const fakeHarnessScript = fileURLToPath(
  new URL('../../../scripts/fake-harness.mjs', import.meta.url),
);

// realpath expands Windows 8.3 names (RUNNER~1) so paths match git output.
const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-rename-')));
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

function file(name: string): string {
  return path.join(repoPath, name);
}

beforeAll(async () => {
  mkdirSync(repoPath, { recursive: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Nest']);
  git(['config', 'user.email', 'nest@example.com']);
  // Restored files keep their bytes instead of the platform line ending.
  git(['config', 'core.autocrlf', 'false']);
  writeFileSync(file('a.txt'), 'one\ntwo\n', 'utf8');
  writeFileSync(file('gone.txt'), 'delete me\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-m', 'init']);

  core = createCore({
    dbPath: path.join(tempRoot, 'nest.db'),
    worktreesRoot: path.join(tempRoot, 'worktrees'),
    fakeHarnessScript,
  });
  const { project } = await core.projects.add(repoPath);
  taskId = core.tasks.ensureCheckout(project.id).id;
});

afterAll(() => {
  core?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('renamed files', () => {
  it('reports the original and the new path of a staged rename', async () => {
    git(['mv', 'a.txt', 'b.txt']);

    const status = await core!.git.status(taskId);
    const renamed = status.files.find((entry) => entry.path === 'b.txt');
    expect(renamed).toMatchObject({
      oldPath: 'a.txt',
      copied: false,
      indexStatus: 'R',
      staged: true,
    });
    // The old path is part of the entry, not a second standalone change.
    expect(status.files.some((entry) => entry.path === 'a.txt')).toBe(false);
  });

  it('restores the original name on discard and leaves a clean status', async () => {
    const cleaned = await core!.git.discard(taskId, ['b.txt']);

    expect(cleaned.files).toEqual([]);
    expect(existsSync(file('b.txt'))).toBe(false);
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(git(['status', '--porcelain'])).toBe('');
  });

  it('unstages both halves of a rename and keeps the workspace file', async () => {
    git(['mv', 'a.txt', 'b.txt']);

    const unstaged = await core!.git.unstage(taskId, ['b.txt']);
    expect(unstaged.files.every((entry) => !entry.staged)).toBe(true);
    const byPath = new Map(unstaged.files.map((entry) => [entry.path, entry]));
    expect(byPath.get('a.txt')).toMatchObject({ indexStatus: ' ', worktreeStatus: 'D' });
    expect(byPath.get('b.txt')).toMatchObject({ untracked: true, oldPath: null });
    // Unstaging never deletes files from the workspace.
    expect(existsSync(file('b.txt'))).toBe(true);

    // The now-unstaged pair can still be discarded back to HEAD.
    const cleaned = await core!.git.discard(taskId, ['a.txt', 'b.txt']);
    expect(cleaned.files).toEqual([]);
    expect(existsSync(file('a.txt'))).toBe(true);
    expect(existsSync(file('b.txt'))).toBe(false);
  });
});

describe('plain changes', () => {
  it('keeps modify, staged add, delete and untracked handling', async () => {
    writeFileSync(file('a.txt'), 'one\nTWO\n', 'utf8');
    writeFileSync(file('added.ts'), 'export const a = 1;\n', 'utf8');
    git(['add', '--', 'added.ts']);
    unlinkSync(file('gone.txt'));
    writeFileSync(file('notes.md'), '# notes\n', 'utf8');

    const dirty = await core!.git.status(taskId);
    const byPath = new Map(dirty.files.map((entry) => [entry.path, entry]));
    expect(byPath.get('a.txt')).toMatchObject({ indexStatus: ' ', worktreeStatus: 'M' });
    expect(byPath.get('added.ts')).toMatchObject({ indexStatus: 'A', staged: true });
    expect(byPath.get('gone.txt')).toMatchObject({ worktreeStatus: 'D' });
    expect(byPath.get('notes.md')).toMatchObject({ untracked: true });

    const cleaned = await core!.git.discard(taskId, ['a.txt', 'added.ts', 'gone.txt', 'notes.md']);
    expect(cleaned.files).toEqual([]);
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(readFileSync(file('gone.txt'), 'utf8')).toBe('delete me\n');
    expect(existsSync(file('added.ts'))).toBe(false);
    expect(existsSync(file('notes.md'))).toBe(false);
  });
});
